import * as vscode from "vscode";
import { AppRunner, AppState, AppInfo } from "./appRunner";

/**
 * Manages the status bar item and startup progress notification
 * for the Encore application runner.
 *
 * Status bar states:
 *   Stopped   — hidden (no clutter)
 *   Starting  — "$(sync~spin) Encore: Building graph..."
 *   Running   — "$(check) Encore :4000"  (green)
 *   Debugging — "$(debug) Encore :4000"  (orange)
 *   Stopping  — "$(sync~spin) Encore: Stopping..."
 *
 * During startup, a progress notification (vscode.window.withProgress)
 * shows live build stages with a Cancel button that stops the app.
 */
export class AppStatusBar implements vscode.Disposable {
  private readonly statusBarItem: vscode.StatusBarItem;
  private readonly disposables: vscode.Disposable[] = [];
  private progressResolve: (() => void) | undefined;
  private lastProgressMessage: string | undefined;

  constructor(private readonly appRunner: AppRunner) {
    this.statusBarItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Left,
      100,
    );
    this.statusBarItem.name = "Encore Application";
    this.statusBarItem.command = "encore.showAppOutput";

    this.disposables.push(
      this.statusBarItem,
      this.appRunner.onDidChangeState((state) =>
        this.handleStateChange(state),
      ),
      this.appRunner.onDidUpdateInfo((info) =>
        this.handleInfoUpdate(info),
      ),
    );

    // Initialise from current state.
    this.handleStateChange(this.appRunner.getState());
  }

  dispose(): void {
    this.dismissProgress();
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
  }

  // -------------------------------------------------------------------------
  // Event handlers
  // -------------------------------------------------------------------------

  private handleStateChange(state: AppState): void {
    switch (state) {
      case AppState.Stopped:
        this.dismissProgress();
        this.statusBarItem.hide();
        break;

      case AppState.Starting:
        this.updateStarting("Starting\u2026");
        this.showProgress();
        this.statusBarItem.show();
        break;

      case AppState.Running:
        this.dismissProgress();
        this.updateRunning();
        this.statusBarItem.show();
        break;

      case AppState.Debugging:
        this.dismissProgress();
        this.updateDebugging();
        this.statusBarItem.show();
        break;

      case AppState.Stopping:
        this.dismissProgress();
        this.statusBarItem.text = "$(sync~spin) Encore: Stopping\u2026";
        this.statusBarItem.tooltip = "Encore application is stopping";
        this.statusBarItem.backgroundColor = undefined;
        this.statusBarItem.show();
        break;
    }
  }

  private handleInfoUpdate(info: AppInfo): void {
    const state = this.appRunner.getState();

    if (state === AppState.Starting && info.buildStage) {
      this.updateStarting(info.buildStage);
    }

    if (state === AppState.Running) {
      this.updateRunning();
    }

    if (state === AppState.Debugging) {
      this.updateDebugging();
    }
  }

  // -------------------------------------------------------------------------
  // Status bar update helpers
  // -------------------------------------------------------------------------

  private updateStarting(stage: string): void {
    this.statusBarItem.text = `$(sync~spin) Encore: ${stage}`;
    this.statusBarItem.tooltip = `Encore application is starting \u2014 ${stage}`;
    this.statusBarItem.backgroundColor = undefined;
    this.lastProgressMessage = stage;
  }

  private updateRunning(): void {
    const info = this.appRunner.getInfo();
    const port = extractPort(info.baseUrl);
    const portLabel = port ? ` :${port}` : "";
    this.statusBarItem.text = `$(check) Encore${portLabel}`;
    this.statusBarItem.tooltip = info.baseUrl
      ? `Encore application running at ${info.baseUrl}\nClick to show output`
      : "Encore application running\nClick to show output";
    this.statusBarItem.backgroundColor = undefined;
  }

  private updateDebugging(): void {
    const info = this.appRunner.getInfo();
    const port = extractPort(info.baseUrl);
    const portLabel = port ? ` :${port}` : "";
    this.statusBarItem.text = `$(debug) Encore${portLabel}`;
    this.statusBarItem.tooltip = info.baseUrl
      ? `Encore application debugging at ${info.baseUrl}\nClick to show output`
      : "Encore application debugging\nClick to show output";
    this.statusBarItem.backgroundColor = new vscode.ThemeColor(
      "statusBarItem.warningBackground",
    );
  }

  // -------------------------------------------------------------------------
  // Progress notification
  // -------------------------------------------------------------------------

  /**
   * Show a progress notification with a Cancel button.
   * Updates live as build stages change via handleInfoUpdate.
   */
  private showProgress(): void {
    this.dismissProgress();

    vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "Encore",
        cancellable: true,
      },
      (progress, token) => {
        token.onCancellationRequested(() => {
          this.appRunner.stop();
        });

        progress.report({ message: "Starting\u2026" });

        // Subscribe to info updates to push build stage changes
        // into the progress notification.
        const infoListener = this.appRunner.onDidUpdateInfo((info) => {
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

  private dismissProgress(): void {
    if (this.progressResolve) {
      this.progressResolve();
      this.progressResolve = undefined;
    }
    this.lastProgressMessage = undefined;
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
