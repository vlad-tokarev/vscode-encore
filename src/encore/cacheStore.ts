import * as vscode from "vscode";
import * as fs from "fs";

import { GoFileChangeEvent } from "../utils/goFileWatcher";
import { shouldSkipGeneratedGoFile } from "../utils/workspaceScan";

export interface KeyspaceInfo {
  /** Variable name of the keyspace (e.g. "RequestsPerUser"). */
  name: string;
  /** Keyspace constructor function (e.g. "NewIntKeyspace"). */
  constructor: string;
  /** Absolute path to the Go file containing the keyspace declaration. */
  filePath: string;
  /** Zero-based line number of the keyspace declaration. */
  line: number;
}

export interface CacheClusterInfo {
  /** The string identifier passed to cache.NewCluster (e.g. "my-cache-cluster"). */
  clusterName: string;
  /** Go variable name holding the cluster (e.g. "MyCacheCluster"). */
  varName: string;
  /** Absolute path to the Go file containing the cluster declaration. */
  filePath: string;
  /** Zero-based line number of the cluster declaration. */
  line: number;
  /** Keyspaces belonging to this cluster. */
  keyspaces: KeyspaceInfo[];
}

// Matches: var <VarName> = cache.NewCluster("<cluster-name>"
// Also matches inside var (...) blocks where "var" is absent.
const CLUSTER_RE =
  /^(?:var\s+)?(\w+)\s*=\s*cache\.NewCluster\(\s*"([^"]+)"/;

// Matches: var <VarName> = cache.New<Kind>Keyspace[...](<clusterRef>
// The cluster reference can be a qualified name like "platform.CacheCluster".
// Also matches inside var (...) blocks where "var" is absent.
const KEYSPACE_RE =
  /^(?:var\s+)?(\w+)\s*=\s*cache\.(New\w+Keyspace)\s*\[[^\]]*\]\s*\(\s*([\w.]+)/;

/**
 * In-memory store for discovered Encore cache clusters and keyspaces.
 *
 * Discovery is file-based — scans Go files for cache.NewCluster and
 * cache.New*Keyspace declarations. Uses a per-file cache so only
 * changed files are re-scanned via the shared GoFileWatcher.
 */
export class CacheStore {
  private readonly onDidChangeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.onDidChangeEmitter.event;

  private clusters = new Map<string, CacheClusterInfo>();
  private loaded = false;

  /** Per-file cache: filePath → parsed cluster declarations. */
  private fileClusterCache = new Map<string, CacheClusterInfo[]>();
  /** Per-file cache: filePath → parsed keyspace declarations (with clusterVarName). */
  private fileKeyspaceCache = new Map<string, Array<KeyspaceInfo & { clusterVar: string }>>();

  getClusters(): readonly CacheClusterInfo[] {
    return [...this.clusters.values()].sort((a, b) =>
      a.clusterName.localeCompare(b.clusterName),
    );
  }

  isLoaded(): boolean {
    return this.loaded;
  }

  /**
   * Scan a batch of Go file URIs (used for initial scan and refresh).
   */
  async scanFiles(uris: vscode.Uri[]): Promise<void> {
    for (const uri of uris) {
      await this.scanFile(uri.fsPath);
    }
    this.rebuildClusters();
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
        const hadClusters = this.fileClusterCache.delete(filePath);
        const hadKeyspaces = this.fileKeyspaceCache.delete(filePath);
        if (hadClusters || hadKeyspaces) {
          changed = true;
        }
        continue;
      }

      this.fileClusterCache.delete(filePath);
      this.fileKeyspaceCache.delete(filePath);
      await this.scanFile(filePath);
      changed = true;
    }

    if (changed) {
      this.rebuildClusters();
      this.onDidChangeEmitter.fire();
    }
  }

  refresh(): void {
    this.fileClusterCache.clear();
    this.fileKeyspaceCache.clear();
  }

  dispose(): void {
    this.onDidChangeEmitter.dispose();
  }

  // ---------------------------------------------------------------------------
  // Scanning
  // ---------------------------------------------------------------------------

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
    const fileClusters: CacheClusterInfo[] = [];
    const fileKeyspaces: Array<KeyspaceInfo & { clusterVar: string }> = [];

    for (let i = 0; i < lines.length; i++) {
      const trimmed = lines[i].trimStart();

      const clusterMatch = trimmed.match(CLUSTER_RE);
      if (clusterMatch) {
        fileClusters.push({
          varName: clusterMatch[1],
          clusterName: clusterMatch[2],
          filePath,
          line: i,
          keyspaces: [],
        });
        continue;
      }

      const keyspaceMatch = trimmed.match(KEYSPACE_RE);
      if (keyspaceMatch) {
        fileKeyspaces.push({
          name: keyspaceMatch[1],
          constructor: keyspaceMatch[2],
          filePath,
          line: i,
          clusterVar: keyspaceMatch[3],
        });
      }
    }

    this.fileClusterCache.set(filePath, fileClusters);
    this.fileKeyspaceCache.set(filePath, fileKeyspaces);
  }

  /**
   * Rebuild the clusters map by linking keyspaces to their cluster
   * via the Go variable name reference.
   *
   * Keyspaces can reference a cluster by bare name ("CacheCluster") or
   * qualified name ("platform.CacheCluster"). Both forms are matched
   * against the cluster variable name.
   */
  private rebuildClusters(): void {
    // Collect all clusters keyed by their Go variable name.
    const clustersByVar = new Map<string, CacheClusterInfo>();

    for (const fileClusters of this.fileClusterCache.values()) {
      for (const cluster of fileClusters) {
        clustersByVar.set(cluster.varName, {
          ...cluster,
          keyspaces: [],
        });
      }
    }

    // Assign keyspaces to their clusters.
    // The clusterVar from the keyspace regex can be "CacheCluster" or
    // "platform.CacheCluster". Extract the final identifier after the
    // last dot to match against the cluster variable name.
    for (const fileKeyspaces of this.fileKeyspaceCache.values()) {
      for (const ks of fileKeyspaces) {
        const bareVar = ks.clusterVar.includes(".")
          ? ks.clusterVar.substring(ks.clusterVar.lastIndexOf(".") + 1)
          : ks.clusterVar;
        const cluster = clustersByVar.get(bareVar);
        if (cluster) {
          cluster.keyspaces.push({
            name: ks.name,
            constructor: ks.constructor,
            filePath: ks.filePath,
            line: ks.line,
          });
        }
      }
    }

    // Sort keyspaces within each cluster.
    for (const cluster of clustersByVar.values()) {
      cluster.keyspaces.sort((a, b) => a.name.localeCompare(b.name));
    }

    this.clusters = new Map(
      [...clustersByVar.entries()].map(([, cluster]) => [cluster.clusterName, cluster]),
    );
  }
}
