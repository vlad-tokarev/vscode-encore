import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";

import { GoFileChangeEvent } from "../utils/goFileWatcher";
import { shouldSkipGeneratedGoFile } from "../utils/workspaceScan";

export interface EndpointInfo {
  name: string;
  access: "public" | "private" | "auth" | "";
  methods: string[];
  path: string;
  /** Absolute path to the Go file containing the endpoint. */
  filePath: string;
  /** Zero-based line number of the //encore:api directive. */
  line: number;
  raw: boolean;
}

export interface ServiceInfo {
  name: string;
  /** Absolute path to the service package directory. */
  dirPath: string;
  /** Absolute path to the file containing the //encore:service directive, if present. */
  serviceFilePath?: string;
  /** Zero-based line number of the //encore:service directive. */
  serviceFileLine?: number;
  endpoints: EndpointInfo[];
}

// Regex matching //encore:api directive and capturing the rest of the line.
const API_DIRECTIVE_RE = /^\/\/encore:api\b(.*)$/;

// Regex matching //encore:service directive.
const SERVICE_DIRECTIVE_RE = /^\/\/encore:service\b/;

// Regex matching a Go function declaration — both package-level and method receivers.
// Captures the function name.
const FUNC_RE = /^func\s+(?:\(\s*\w+\s+\*?\w+\s*\)\s+)?(\w+)\s*\(/;

/**
 * In-memory store for discovered Encore services and their API endpoints.
 *
 * Discovery is purely file-based — scans Go files for //encore:api and
 * //encore:service directives. No CLI calls, no network.
 *
 * Uses a per-file cache: only changed files are re-scanned when
 * the shared GoFileWatcher fires. Initial scan runs once via scanFiles().
 */
export class ServiceStore {
  private readonly onDidChangeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.onDidChangeEmitter.event;

  private services = new Map<string, ServiceInfo>();
  private loaded = false;

  /** Per-file cache: filePath → parsed endpoints from that file. */
  private fileCache = new Map<string, EndpointInfo[]>();
  /** Per-file cache: filePath → line number of //encore:service directive (-1 if absent). */
  private serviceFileCache = new Map<string, number>();

  getServices(): readonly ServiceInfo[] {
    return [...this.services.values()].sort((a, b) =>
      a.name.localeCompare(b.name),
    );
  }

  isLoaded(): boolean {
    return this.loaded;
  }

  /**
   * Scan a batch of Go file URIs (used for initial scan and refresh).
   * Reads files asynchronously to avoid blocking the extension host.
   */
  async scanFiles(uris: vscode.Uri[]): Promise<void> {
    for (const uri of uris) {
      await this.scanFile(uri.fsPath);
    }
    this.rebuildServices();
    this.loaded = true;
    this.onDidChangeEmitter.fire();
  }

  /** Handle batched file change events from the shared GoFileWatcher. */
  async handleFileChanges(events: GoFileChangeEvent[]): Promise<void> {
    let changed = false;

    for (const event of events) {
      const filePath = event.uri.fsPath;

      if (shouldSkipGeneratedGoFile(filePath)) {
        continue;
      }

      if (event.kind === "delete") {
        const hadFile = this.fileCache.delete(filePath);
        const hadServiceDirective = this.serviceFileCache.delete(filePath);
        if (hadFile || hadServiceDirective) {
          changed = true;
        }
        continue;
      }

      this.fileCache.delete(filePath);
      this.serviceFileCache.delete(filePath);
      await this.scanFile(filePath);
      changed = true;
    }

    if (changed) {
      this.rebuildServices();
      this.onDidChangeEmitter.fire();
    }
  }

  refresh(): void {
    this.fileCache.clear();
    this.serviceFileCache.clear();
  }

  dispose(): void {
    this.onDidChangeEmitter.dispose();
  }

  // ---------------------------------------------------------------------------
  // Scanning
  // ---------------------------------------------------------------------------

  /**
   * Scan a single Go file for //encore:api and //encore:service directives.
   * Reads the file asynchronously to avoid blocking the extension host.
   */
  private async scanFile(filePath: string): Promise<void> {
    if (shouldSkipGeneratedGoFile(filePath)) {
      return;
    }

    let content: string;
    try {
      content = await fs.promises.readFile(filePath, "utf-8");
    } catch {
      return;
    }

    const lines = content.split("\n");
    const endpoints: EndpointInfo[] = [];
    let hasServiceDirective = false;
    let serviceDirectiveLine = -1;

    for (let i = 0; i < lines.length; i++) {
      const trimmed = lines[i].trimStart();

      if (SERVICE_DIRECTIVE_RE.test(trimmed)) {
        hasServiceDirective = true;
        serviceDirectiveLine = i;
        continue;
      }

      const apiMatch = trimmed.match(API_DIRECTIVE_RE);
      if (!apiMatch) {
        continue;
      }

      const directiveOptions = apiMatch[1].trim();
      const endpoint = parseApiDirective(directiveOptions, filePath, i);

      // Look for the function name on the next non-empty, non-comment line.
      for (let j = i + 1; j < lines.length && j <= i + 5; j++) {
        const nextLine = lines[j].trimStart();
        if (nextLine.length === 0 || nextLine.startsWith("//")) {
          continue;
        }
        const funcMatch = nextLine.match(FUNC_RE);
        if (funcMatch) {
          endpoint.name = funcMatch[1];
        }
        break;
      }

      if (endpoint.name.length > 0) {
        endpoints.push(endpoint);
      }
    }

    this.fileCache.set(filePath, endpoints);
    this.serviceFileCache.set(filePath, serviceDirectiveLine);
  }

  /**
   * Rebuild the services map from the per-file caches.
   *
   * A service is identified by its package directory. The service name
   * is the directory basename. A directory is considered a service if
   * any file in the directory contains //encore:service or //encore:api.
   */
  private rebuildServices(): void {
    // Collect all directories that contain endpoints or a service directive.
    const dirEndpoints = new Map<string, EndpointInfo[]>();
    const dirHasServiceDirective = new Set<string>();

    for (const [filePath, endpoints] of this.fileCache) {
      if (endpoints.length === 0) {
        continue;
      }
      const dir = path.dirname(filePath);
      const existing = dirEndpoints.get(dir) ?? [];
      existing.push(...endpoints);
      dirEndpoints.set(dir, existing);
    }

    /** Map from directory path to { filePath, line } of the //encore:service directive. */
    const dirServiceDirective = new Map<string, { filePath: string; line: number }>();

    for (const [filePath, directiveLine] of this.serviceFileCache) {
      if (directiveLine >= 0) {
        const dir = path.dirname(filePath);
        dirServiceDirective.set(dir, { filePath, line: directiveLine });
        if (!dirEndpoints.has(dir)) {
          dirEndpoints.set(dir, []);
        }
      }
    }

    const newServices = new Map<string, ServiceInfo>();

    for (const [dir, endpoints] of dirEndpoints) {
      const name = path.basename(dir);
      endpoints.sort((a, b) => a.name.localeCompare(b.name));
      const directive = dirServiceDirective.get(dir);
      newServices.set(dir, {
        name,
        dirPath: dir,
        serviceFilePath: directive?.filePath,
        serviceFileLine: directive?.line,
        endpoints,
      });
    }

    // Also include directories with //encore:service but no endpoints.
    for (const [dir, directive] of dirServiceDirective) {
      if (!newServices.has(dir)) {
        const name = path.basename(dir);
        newServices.set(dir, {
          name,
          dirPath: dir,
          serviceFilePath: directive.filePath,
          serviceFileLine: directive.line,
          endpoints: [],
        });
      }
    }

    this.services = newServices;
  }
}

/**
 * Parse the options after //encore:api into an EndpointInfo (without name,
 * which is resolved from the function signature below the directive).
 */
function parseApiDirective(
  optionsText: string,
  filePath: string,
  line: number,
): EndpointInfo {
  const endpoint: EndpointInfo = {
    name: "",
    access: "",
    methods: [],
    path: "",
    filePath,
    line,
    raw: false,
  };

  const tokens = optionsText.split(/\s+/).filter((t) => t.length > 0);

  for (const token of tokens) {
    if (token === "public" || token === "private" || token === "auth") {
      endpoint.access = token;
      continue;
    }
    if (token === "raw") {
      endpoint.raw = true;
      continue;
    }
    if (token.startsWith("method=")) {
      endpoint.methods = token.substring(7).split(",").filter((m) => m.length > 0);
      continue;
    }
    if (token.startsWith("path=")) {
      endpoint.path = token.substring(5);
      continue;
    }
    // Bare path (starts with /).
    if (token.startsWith("/")) {
      endpoint.path = token;
      continue;
    }
    // Bare HTTP methods like GET,POST.
    if (/^[A-Z]+(?:,[A-Z]+)*$/.test(token) && token !== "raw") {
      endpoint.methods = token.split(",");
      continue;
    }
  }

  return endpoint;
}
