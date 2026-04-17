import * as vscode from "vscode";
import * as fs from "fs";

import { GoFileChangeEvent } from "../utils/goFileWatcher";
import { shouldSkipGoWorkspaceFile } from "../utils/workspaceScan";

export interface BucketInfo {
  /** The string identifier passed to objects.NewBucket (e.g. "profile-pictures"). */
  bucketName: string;
  /** Go variable name holding the bucket (e.g. "ProfilePictures"). */
  varName: string;
  /** Absolute path to the Go file containing the bucket declaration. */
  filePath: string;
  /** Zero-based line number of the bucket declaration. */
  line: number;
  /** Whether the bucket has Public: true in its config. */
  isPublic: boolean;
  /** Whether the bucket has Versioned: true in its config. */
  isVersioned: boolean;
}

// Matches: var <VarName> = objects.NewBucket("<bucket-name>"
// Also matches inside var (...) blocks where "var" is absent.
const BUCKET_RE =
  /^(?:var\s+)?(\w+)\s*=\s*objects\.NewBucket\(\s*"([^"]+)"/;

// Matches: Public: true
const PUBLIC_RE = /Public:\s*true/;

// Matches: Versioned: true
const VERSIONED_RE = /Versioned:\s*true/;

/**
 * In-memory store for discovered Encore object storage buckets.
 *
 * Discovery is file-based — scans Go files for objects.NewBucket
 * declarations. Uses a per-file cache so only changed files are
 * re-scanned via the shared GoFileWatcher.
 */
export class BucketStore {
  private readonly onDidChangeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.onDidChangeEmitter.event;

  private buckets = new Map<string, BucketInfo>();
  private loaded = false;

  /** Per-file cache: filePath → parsed bucket declarations. */
  private fileCache = new Map<string, BucketInfo[]>();

  getBuckets(): readonly BucketInfo[] {
    return [...this.buckets.values()].sort((a, b) =>
      a.bucketName.localeCompare(b.bucketName),
    );
  }

  isLoaded(): boolean {
    return this.loaded;
  }

  async scanFiles(uris: vscode.Uri[]): Promise<void> {
    for (const uri of uris) {
      await this.scanFile(uri.fsPath);
    }
    this.rebuildBuckets();
    this.loaded = true;
    this.onDidChangeEmitter.fire();
  }

  async handleFileChanges(events: GoFileChangeEvent[]): Promise<void> {
    let changed = false;

    for (const event of events) {
      const filePath = event.uri.fsPath;

      if (shouldSkipGoWorkspaceFile(filePath)) {
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
      this.rebuildBuckets();
      this.onDidChangeEmitter.fire();
    }
  }

  refresh(): void {
    this.fileCache.clear();
  }

  dispose(): void {
    this.onDidChangeEmitter.dispose();
  }

  // ---------------------------------------------------------------------------
  // Scanning
  // ---------------------------------------------------------------------------

  private async scanFile(filePath: string): Promise<void> {
    if (shouldSkipGoWorkspaceFile(filePath)) {
      return;
    }

    let content: string;
    try {
      content = await fs.promises.readFile(filePath, "utf-8");
    } catch {
      return;
    }

    const lines = content.split("\n");
    const entries: BucketInfo[] = [];

    for (let i = 0; i < lines.length; i++) {
      const trimmed = lines[i].trimStart();

      const bucketMatch = trimmed.match(BUCKET_RE);
      if (bucketMatch) {
        // Look ahead for Public and Versioned flags in the next few lines.
        let isPublic = false;
        let isVersioned = false;
        for (let j = i; j < Math.min(i + 5, lines.length); j++) {
          if (PUBLIC_RE.test(lines[j])) {
            isPublic = true;
          }
          if (VERSIONED_RE.test(lines[j])) {
            isVersioned = true;
          }
        }

        entries.push({
          varName: bucketMatch[1],
          bucketName: bucketMatch[2],
          filePath,
          line: i,
          isPublic,
          isVersioned,
        });
      }
    }

    this.fileCache.set(filePath, entries);
  }

  private rebuildBuckets(): void {
    const bucketMap = new Map<string, BucketInfo>();

    for (const entries of this.fileCache.values()) {
      for (const entry of entries) {
        bucketMap.set(entry.bucketName, entry);
      }
    }

    this.buckets = bucketMap;
  }
}
