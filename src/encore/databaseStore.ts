import * as vscode from "vscode";
import { exec } from "child_process";
import * as fs from "fs";
import * as path from "path";

import { GoFileChangeEvent } from "../utils/goFileWatcher";
import { buildEncoreEnv, isEncoreCliAvailable } from "../utils/encoreEnv";
import { shouldSkipGoWorkspaceFile } from "../utils/workspaceScan";

export interface DatabaseInfo {
  /** The string identifier passed to sqldb.NewDatabase or sqldb.Named (e.g. "platform"). */
  name: string;
  /** Absolute path to the Go file containing the primary declaration (NewDatabase preferred). */
  filePath: string;
  /** Zero-based line number of the declaration. */
  line: number;
  /** Whether the database was declared with sqldb.NewDatabase (true) or sqldb.Named (false). */
  isPrimary: boolean;
  /** Absolute path to the migrations directory (resolved from Migrations config field). */
  migrationsDir?: string;
}

// Matches: var <VarName> = sqldb.NewDatabase("<db-name>"
// Also matches inside var (...) blocks where "var" is absent.
const NEW_DB_RE =
  /^(?:var\s+)?(\w+)\s*=\s*sqldb\.NewDatabase\(\s*"([^"]+)"/;

// Matches: var <VarName> = sqldb.Named("<db-name>"
// Also matches inside var (...) blocks where "var" is absent.
const NAMED_DB_RE =
  /^(?:var\s+)?(\w+)\s*=\s*sqldb\.Named\(\s*"([^"]+)"/;

// Matches: Migrations: "./migrations" (or any quoted path).
const MIGRATIONS_RE = /Migrations:\s*"([^"]+)"/;

const CONN_URI_CACHE_FILE = "encore-db-conn-uris.json";

/**
 * In-memory store for discovered Encore SQL databases.
 *
 * Discovery is file-based — scans Go files for sqldb.NewDatabase and
 * sqldb.Named declarations. Test files (*_test.go) are excluded.
 * Uses a per-file cache so only changed files are re-scanned
 * via the shared GoFileWatcher.
 *
 * Connection URIs are fetched in the background via `encore db conn-uri`
 * and cached both in memory and on disk (globalStorageUri) so the copy
 * button appears instantly on subsequent activations.
 */
export class DatabaseStore {
  private readonly onDidChangeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.onDidChangeEmitter.event;

  private databases = new Map<string, DatabaseInfo>();
  private loaded = false;

  /** Per-file cache: filePath → parsed database references from that file. */
  private fileCache = new Map<string, DatabaseInfo[]>();

  /** Cached connection URIs keyed by database name. */
  private connUriCache = new Map<string, string>();

  /** Database names currently being fetched to avoid duplicate CLI calls. */
  private connUriFetching = new Set<string>();

  /** Absolute path to the disk cache file for connection URIs. */
  private readonly connUriDiskCachePath: string;

  constructor(globalStorageUri: vscode.Uri) {
    this.connUriDiskCachePath = path.join(globalStorageUri.fsPath, CONN_URI_CACHE_FILE);
    this.restoreConnUrisFromDisk();
  }

  getDatabases(): readonly DatabaseInfo[] {
    return [...this.databases.values()].sort((a, b) =>
      a.name.localeCompare(b.name),
    );
  }

  isLoaded(): boolean {
    return this.loaded;
  }

  /** Return the cached connection URI for a database, or undefined if not yet fetched. */
  getConnUri(dbName: string): string | undefined {
    return this.connUriCache.get(dbName);
  }

  /**
   * Scan a batch of Go file URIs (used for initial scan and refresh).
   */
  async scanFiles(uris: vscode.Uri[]): Promise<void> {
    for (const uri of uris) {
      await this.scanFile(uri.fsPath);
    }
    this.rebuildDatabases();
    this.loaded = true;
    this.onDidChangeEmitter.fire();
  }

  /** Handle batched file change events from the shared GoFileWatcher. */
  async handleFileChanges(events: GoFileChangeEvent[]): Promise<void> {
    let changed = false;

    for (const event of events) {
      const filePath = event.uri.fsPath;

      if (this.shouldSkipFile(filePath)) {
        continue;
      }

      if (event.kind === "delete") {
        if (this.fileCache.delete(filePath)) {
          changed = true;
        }
        continue;
      }

      this.fileCache.delete(filePath);
      await this.scanFile(filePath);
      changed = true;
    }

    if (changed) {
      this.rebuildDatabases();
      this.onDidChangeEmitter.fire();
    }
  }

  refresh(): void {
    this.fileCache.clear();
    this.connUriCache.clear();
    this.connUriFetching.clear();
  }

  dispose(): void {
    this.onDidChangeEmitter.dispose();
  }

  /**
   * Fetch connection URIs for all known databases in the background.
   * Each database is fetched independently; successful results are
   * cached and trigger a tree view refresh via onDidChange.
   */
  fetchAllConnUris(): void {
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!cwd || !isEncoreCliAvailable()) {
      return;
    }

    for (const db of this.databases.values()) {
      if (this.connUriCache.has(db.name) || this.connUriFetching.has(db.name)) {
        continue;
      }

      this.connUriFetching.add(db.name);

      exec(
        `encore db conn-uri ${db.name}`,
        { timeout: 60_000, cwd, env: buildEncoreEnv() },
        (error, stdout) => {
          this.connUriFetching.delete(db.name);

          if (error) {
            return;
          }

          const uri = stdout.trim();
          if (uri) {
            this.connUriCache.set(db.name, uri);
            this.persistConnUrisToDisk();
            this.onDidChangeEmitter.fire();
          }
        },
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Connection URI disk cache
  // ---------------------------------------------------------------------------

  private restoreConnUrisFromDisk(): void {
    try {
      const raw = fs.readFileSync(this.connUriDiskCachePath, "utf-8");
      const parsed = JSON.parse(raw);
      if (typeof parsed === "object" && parsed !== null) {
        for (const [key, value] of Object.entries(parsed)) {
          if (typeof value === "string") {
            this.connUriCache.set(key, value);
          }
        }
      }
    } catch {
      // No cache file or malformed — start with an empty cache.
    }
  }

  private persistConnUrisToDisk(): void {
    try {
      const dir = path.dirname(this.connUriDiskCachePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      const data = Object.fromEntries(this.connUriCache);
      fs.writeFileSync(this.connUriDiskCachePath, JSON.stringify(data), "utf-8");
    } catch {
      // Non-critical — disk cache is best-effort.
    }
  }

  // ---------------------------------------------------------------------------
  // Scanning
  // ---------------------------------------------------------------------------

  /**
   * Scan lines following a sqldb.NewDatabase call for a Migrations field.
   * Looks at up to 10 lines after the declaration, stopping at the closing
   * paren/brace. Returns the resolved absolute migrations directory path,
   * or undefined if no Migrations field is found.
   */
  private findMigrationsDir(
    lines: string[],
    startLine: number,
    goFilePath: string,
  ): string | undefined {
    const limit = Math.min(startLine + 10, lines.length);
    for (let j = startLine; j < limit; j++) {
      const migMatch = lines[j].match(MIGRATIONS_RE);
      if (migMatch) {
        const relPath = migMatch[1];
        const dir = path.dirname(goFilePath);
        return path.resolve(dir, relPath);
      }
      // Stop scanning at the closing paren of the NewDatabase call.
      if (j > startLine && /^\s*\)\s*$/.test(lines[j])) {
        break;
      }
    }
    return undefined;
  }

  private shouldSkipFile(filePath: string): boolean {
    return shouldSkipGoWorkspaceFile(filePath);
  }

  private async scanFile(filePath: string): Promise<void> {
    if (this.shouldSkipFile(filePath)) {
      return;
    }

    let content: string;
    try {
      content = await fs.promises.readFile(filePath, "utf-8");
    } catch {
      return;
    }

    const lines = content.split("\n");
    const entries: DatabaseInfo[] = [];

    for (let i = 0; i < lines.length; i++) {
      const trimmed = lines[i].trimStart();

      const newDbMatch = trimmed.match(NEW_DB_RE);
      if (newDbMatch) {
        // Scan subsequent lines for Migrations config field.
        const migrationsDir = this.findMigrationsDir(lines, i, filePath);
        entries.push({
          name: newDbMatch[2],
          filePath,
          line: i,
          isPrimary: true,
          migrationsDir,
        });
        continue;
      }

      const namedMatch = trimmed.match(NAMED_DB_RE);
      if (namedMatch) {
        entries.push({
          name: namedMatch[2],
          filePath,
          line: i,
          isPrimary: false,
        });
      }
    }

    this.fileCache.set(filePath, entries);
  }

  /**
   * Rebuild the deduplicated database map.
   * When multiple files reference the same database name,
   * prefer the sqldb.NewDatabase declaration over sqldb.Named.
   */
  private rebuildDatabases(): void {
    const dbMap = new Map<string, DatabaseInfo>();

    for (const entries of this.fileCache.values()) {
      for (const entry of entries) {
        const existing = dbMap.get(entry.name);
        if (!existing || (entry.isPrimary && !existing.isPrimary)) {
          dbMap.set(entry.name, entry);
        }
      }
    }

    this.databases = dbMap;
  }
}
