import * as vscode from "vscode";
import { AppRunner, AppState, AppInfo } from "./appRunner";
import { AppRunnerRegistry } from "./appRunnerRegistry";

/**
 * Manages one status bar item per running Encore application and a
 * startup progress notification per active startup.
 *
 * Each status bar item shows the Encore app display name and state:
 *   Starting   "$(sync~spin) Encore agenthub: Building graph..."
 *   Running    "$(check) Encore agenthub :4000"
 *   Debugging  "$(debug) Encore agenthub :4000"  (orange bg)
 *   Stopping   "$(sync~spin) Encore agenthub: Stopping..."
 *   Stopped    hidden
 */
export class AppStatusBarManager implements vscode.Disposable {
  private readonly entries = new Map<string, StatusEntry>();
  private readonly disposables: vscode.Disposable[] = [];
  private priorityCursor = 100;

  constructor(private readonly registry: AppRunnerRegistry) {
    this.disposables.push(
      this.registry.onDidChange(() => this.sync()),
    );
    this.sync();
  }

  dispose(): void {
    for (const entry of this.entries.values()) {
      entry.dismissProgress();
      entry.statusBarItem.dispose();
      entry.disposables.forEach((disposable) => disposable.dispose());
    }
    this.entries.clear();
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
  }

  private sync(): void {
    const runners = this.registry.getAll();
    const seen = new Set<string>();

    for (const runner of runners) {
      seen.add(runner.appRootPath);
      let entry = this.entries.get(runner.appRootPath);
      if (!entry) {
        entry = this.createEntry(runner);
        this.entries.set(runner.appRootPath, entry);
      }
      entry.update();
    }

    for (const [rootPath, entry] of [...this.entries]) {
      if (seen.has(rootPath)) {
        continue;
      }
      entry.dismissProgress();
      entry.statusBarItem.dispose();
      entry.disposables.forEach((disposable) => disposable.dispose());
      this.entries.delete(rootPath);
    }
  }

  private createEntry(runner: AppRunner): StatusEntry {
    const statusBarItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Left,
      this.priorityCursor--,
    );
    statusBarItem.name = `Encore: ${runner.displayName}`;
    statusBarItem.command = {
      command: "encore.showAppOutputForApp",
      title: "Show Encore App Output",
      arguments: [runner.appRootPath],
    };

    const entry = new StatusEntry(runner, statusBarItem);

    entry.disposables.push(
      runner.onDidChangeState(() => entry.update()),
      runner.onDidUpdateInfo((info) => entry.handleInfoUpdate(info)),
    );

    return entry;
  }
}

class StatusEntry {
  readonly disposables: vscode.Disposable[] = [];
  private progressResolve: (() => void) | undefined;
  private lastProgressMessage: string | undefined;

  constructor(
    readonly runner: AppRunner,
    readonly statusBarItem: vscode.StatusBarItem,
  ) {}

  update(): void {
    const state = this.runner.getState();

    switch (state) {
      case AppState.Stopped:
        this.dismissProgress();
        this.statusBarItem.hide();
        break;
      case AppState.Starting:
        this.applyStarting("Starting\u2026");
        this.showProgress();
        this.statusBarItem.show();
        break;
      case AppState.Running:
        this.dismissProgress();
        this.applyRunning();
        this.statusBarItem.show();
        break;
      case AppState.Debugging:
        this.dismissProgress();
        this.applyDebugging();
        this.statusBarItem.show();
        break;
      case AppState.Stopping:
        this.dismissProgress();
        this.statusBarItem.text = `$(sync~spin) Encore ${this.runner.displayName}: Stopping\u2026`;
        this.statusBarItem.tooltip = `Encore application "${this.runner.displayName}" is stopping`;
        this.statusBarItem.backgroundColor = undefined;
        this.statusBarItem.show();
        break;
    }
  }

  handleInfoUpdate(info: AppInfo): void {
    const state = this.runner.getState();

    if (state === AppState.Starting && info.buildStage) {
      this.applyStarting(info.buildStage);
    }

    if (state === AppState.Running) {
      this.applyRunning();
    }

    if (state === AppState.Debugging) {
      this.applyDebugging();
    }
  }

  dismissProgress(): void {
    if (this.progressResolve) {
      this.progressResolve();
      this.progressResolve = undefined;
    }
    this.lastProgressMessage = undefined;
  }

  private applyStarting(stage: string): void {
    this.statusBarItem.text = `$(sync~spin) Encore ${this.runner.displayName}: ${stage}`;
    this.statusBarItem.tooltip = `Encore "${this.runner.displayName}" is starting \u2014 ${stage}`;
    this.statusBarItem.backgroundColor = undefined;
    this.lastProgressMessage = stage;
  }

  private applyRunning(): void {
    const info = this.runner.getInfo();
    const port = extractPort(info.baseUrl);
    const portLabel = port ? ` :${port}` : "";
    this.statusBarItem.text = `$(check) Encore ${this.runner.displayName}${portLabel}`;
    this.statusBarItem.tooltip = info.baseUrl
      ? `Encore "${this.runner.displayName}" running at ${info.baseUrl}\nClick to show output`
      : `Encore "${this.runner.displayName}" running\nClick to show output`;
    this.statusBarItem.backgroundColor = undefined;
  }

  private applyDebugging(): void {
    const info = this.runner.getInfo();
    const port = extractPort(info.baseUrl);
    const portLabel = port ? ` :${port}` : "";
    this.statusBarItem.text = `$(debug) Encore ${this.runner.displayName}${portLabel}`;
    this.statusBarItem.tooltip = info.baseUrl
      ? `Encore "${this.runner.displayName}" debugging at ${info.baseUrl}\nClick to show output`
      : `Encore "${this.runner.displayName}" debugging\nClick to show output`;
    this.statusBarItem.backgroundColor = new vscode.ThemeColor(
      "statusBarItem.warningBackground",
    );
  }

  private showProgress(): void {
    this.dismissProgress();

    vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Encore "${this.runner.displayName}"`,
        cancellable: true,
      },
      (progress, token) => {
        token.onCancellationRequested(() => {
          this.runner.stop();
        });

        progress.report({ message: "Starting\u2026" });

        const infoListener = this.runner.onDidUpdateInfo((info) => {
          if (info.buildStage && info.buildStage !== this.lastProgressMessage) {
            this.lastProgressMessage = info.buildStage;
            progress.report({ message: info.buildStage });
          }
        });

        return new Promise<void>((resolve) => {
          this.progressResolve = () => {
            infoListener.dispose();
            resolve();
          };
        });
      },
    );
  }
}

function extractPort(url: string | undefined): string | undefined {
  if (!url) {
    return undefined;
  }
  try {
    return new URL(url).port;
  } catch {
    return undefined;
  }
}
