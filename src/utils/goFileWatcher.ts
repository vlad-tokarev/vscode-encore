import * as vscode from "vscode";
import { isVisibleWorkspaceFile } from "./workspaceScan";

export type GoFileChangeKind = "change" | "create" | "delete";

export interface GoFileChangeEvent {
  uri: vscode.Uri;
  kind: GoFileChangeKind;
}

/**
 * Shared FileSystemWatcher for *.go files.
 *
 * Instead of each store creating its own watcher (and triggering
 * independent synchronous scans on every file change), a single
 * watcher collects events and delivers them in a debounced batch.
 *
 * Subscribers receive the batch after the debounce window closes,
 * so a rapid series of file changes (git checkout, go generate,
 * encore daemon regeneration) results in one callback per subscriber
 * rather than N callbacks per subscriber.
 */
export class GoFileWatcher {
  private readonly watcher: vscode.FileSystemWatcher;
  private readonly listeners: Array<(events: GoFileChangeEvent[]) => void> = [];
  private pendingEvents: GoFileChangeEvent[] = [];
  private debounceTimer: NodeJS.Timeout | undefined;
  private readonly debounceMs: number;

  constructor(debounceMs = 300) {
    this.debounceMs = debounceMs;
    this.watcher = vscode.workspace.createFileSystemWatcher("**/*.go");

    this.watcher.onDidChange((uri) => this.enqueue(uri, "change"));
    this.watcher.onDidCreate((uri) => this.enqueue(uri, "create"));
    this.watcher.onDidDelete((uri) => this.enqueue(uri, "delete"));
  }

  /**
   * Register a callback that receives batched file change events
   * after the debounce window closes.
   */
  onDidChangeFiles(listener: (events: GoFileChangeEvent[]) => void): void {
    this.listeners.push(listener);
  }

  dispose(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = undefined;
    }
    this.watcher.dispose();
  }

  private enqueue(uri: vscode.Uri, kind: GoFileChangeKind): void {
    if (!isVisibleWorkspaceFile(uri)) {
      return;
    }

    this.pendingEvents.push({ uri, kind });

    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }

    this.debounceTimer = setTimeout(() => {
      this.flush();
    }, this.debounceMs);
  }

  private flush(): void {
    const events = this.pendingEvents;
    this.pendingEvents = [];
    this.debounceTimer = undefined;

    for (const listener of this.listeners) {
      listener(events);
    }
  }
}
