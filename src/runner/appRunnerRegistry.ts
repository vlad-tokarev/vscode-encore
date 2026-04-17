import * as vscode from "vscode";

import { DiscoveredApp } from "../utils/discoveredApps";
import { EncoreAppState } from "../utils/encoreAppState";
import { AppRunner, AppState } from "./appRunner";

/**
 * Manages one `AppRunner` per discovered Encore application.
 *
 * Runners are created as apps appear in `EncoreAppState` and disposed when
 * they disappear, unless the runner is still active — an active runner is
 * kept around until the user stops it to avoid terminating a running
 * application when encore.app is briefly absent (e.g. during a save).
 */
export class AppRunnerRegistry implements vscode.Disposable {
  private readonly runners = new Map<string, AppRunner>();
  private readonly perRunnerSubscriptions = new Map<string, vscode.Disposable[]>();
  private readonly onDidChangeEmitter = new vscode.EventEmitter<void>();
  /**
   * Fires whenever the registry's set of runners changes OR any runner's
   * state or info updates. Listeners can treat it as a single refresh
   * signal for UI.
   */
  readonly onDidChange = this.onDidChangeEmitter.event;

  private readonly stateSubscription: vscode.Disposable;

  constructor(private readonly encoreAppState: EncoreAppState) {
    this.stateSubscription = this.encoreAppState.onDidChange(() => {
      this.syncFromEncoreAppState();
    });
    this.syncFromEncoreAppState();
  }

  get(appRootPath: string): AppRunner | undefined {
    return this.runners.get(appRootPath);
  }

  getAll(): AppRunner[] {
    return [...this.runners.values()];
  }

  /**
   * Return runners that are currently active (not in Stopped state).
   * Useful for the status bar and Command Palette prompts.
   */
  getActiveRunners(): AppRunner[] {
    return this.getAll().filter(
      (runner) => runner.getState() !== AppState.Stopped,
    );
  }

  dispose(): void {
    this.stateSubscription.dispose();
    for (const runner of this.runners.values()) {
      runner.dispose();
    }
    this.runners.clear();
    for (const subs of this.perRunnerSubscriptions.values()) {
      for (const sub of subs) {
        sub.dispose();
      }
    }
    this.perRunnerSubscriptions.clear();
    this.onDidChangeEmitter.dispose();
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private syncFromEncoreAppState(): void {
    const discoveredApps = this.encoreAppState.getDiscoveredApps();
    const discoveredRoots = new Set(discoveredApps.map((app) => app.rootPath));

    // Remove runners whose app no longer exists — but only if stopped.
    for (const [rootPath, runner] of this.runners) {
      if (discoveredRoots.has(rootPath)) {
        continue;
      }
      if (runner.getState() === AppState.Stopped) {
        this.disposeRunner(rootPath);
      }
    }

    // Add missing runners and refresh display names.
    for (const app of discoveredApps) {
      const existing = this.runners.get(app.rootPath);
      if (existing) {
        // Display name changes are rare; a re-create on name change is not
        // worth the complexity, so they are ignored for the lifetime of a runner.
        continue;
      }

      this.createRunner(app);
    }

    this.onDidChangeEmitter.fire();
  }

  private createRunner(app: DiscoveredApp): void {
    const runner = new AppRunner(app.rootPath, app.displayName);
    this.runners.set(app.rootPath, runner);

    const subscriptions: vscode.Disposable[] = [
      runner.onDidChangeState(() => {
        this.onDidChangeEmitter.fire();
        // If a runner reaches Stopped after its app was removed, dispose it.
        if (
          runner.getState() === AppState.Stopped
          && !this.encoreAppState
            .getDiscoveredApps()
            .some((discovered) => discovered.rootPath === app.rootPath)
        ) {
          this.disposeRunner(app.rootPath);
          this.onDidChangeEmitter.fire();
        }
      }),
      runner.onDidUpdateInfo(() => {
        this.onDidChangeEmitter.fire();
      }),
    ];
    this.perRunnerSubscriptions.set(app.rootPath, subscriptions);
  }

  private disposeRunner(rootPath: string): void {
    const runner = this.runners.get(rootPath);
    if (!runner) {
      return;
    }
    runner.dispose();
    this.runners.delete(rootPath);

    const subs = this.perRunnerSubscriptions.get(rootPath);
    if (subs) {
      for (const sub of subs) {
        sub.dispose();
      }
      this.perRunnerSubscriptions.delete(rootPath);
    }
  }
}
