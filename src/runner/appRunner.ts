import * as vscode from "vscode";
import { ChildProcess, spawn } from "child_process";

import { buildEncoreEnv, isEncoreCliAvailable, promptMissingCli } from "../utils/encoreEnv";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export enum AppState {
  Stopped = "stopped",
  Starting = "starting",
  Running = "running",
  Debugging = "debugging",
  Stopping = "stopping",
}

export interface RunOptions {
  debug: boolean;
  port: number;
  watch: boolean;
  logLevel?: string;
  stopOnEntry: boolean;
}

export interface AppInfo {
  baseUrl?: string;
  dashboardUrl?: string;
  pid?: number;
  delvePort?: number;
  /** Human-readable build stage label shown in progress UI. */
  buildStage?: string;
}

// ---------------------------------------------------------------------------
// Regex patterns for parsing Encore CLI stderr output
// ---------------------------------------------------------------------------

const API_URL_PATTERN = /Your API is running at:\s+(https?:\/\/\S+)/;
const DASHBOARD_URL_PATTERN = /Development Dashboard URL:\s+(https?:\/\/\S+)/;
const PROCESS_ID_PATTERN = /Process ID:\s+(\d+)/;
const DELVE_READY_PATTERN = /API server listening at:\s+(\S+)/;

/**
 * Extract the human-readable stage label from a spinner line.
 * Spinner lines from the Encore CLI look like:
 *   "  \u28CB Building Encore application graph... "
 * The braille character is the spinner frame; the rest is the stage label.
 */
const SPINNER_STAGE_PATTERN = /[\u2800-\u28FF]\s+(.+?)\.{0,3}\s*$/;

/**
 * Strip ANSI escape sequences and all terminal control characters from
 * CLI output. The Encore CLI emits cursor-movement codes, line-erase
 * sequences, colour codes, and OSC sequences that render as garbage in
 * a VS Code OutputChannel.
 */
// eslint-disable-next-line no-control-regex
const ANSI_ESCAPE_PATTERN = /\x1b\[[0-9;?]*[A-Za-z]|\x1b\].*?(?:\x07|\x1b\\)|\x1b[0-9A-Za-z]|\r/g;

function stripAnsi(text: string): string {
  return text.replace(ANSI_ESCAPE_PATTERN, "");
}

const SPINNER_LINE_PATTERN = /[\u2800-\u28FF]/;

function cleanCliOutput(text: string): string {
  const stripped = stripAnsi(text);
  const lines = stripped.split("\n");
  const result: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }
    if (SPINNER_LINE_PATTERN.test(trimmed)) {
      continue;
    }
    if (/^\d+$/.test(trimmed)) {
      continue;
    }
    result.push(line);
  }

  return result.length > 0 ? result.join("\n") + "\n" : "";
}

function extractBuildStage(text: string): string | undefined {
  const lines = text.split("\n");
  let lastStage: string | undefined;

  for (const line of lines) {
    const match = line.trim().match(SPINNER_STAGE_PATTERN);
    if (match) {
      lastStage = match[1].trim();
    }
  }

  return lastStage;
}

// ---------------------------------------------------------------------------
// AppRunner
// ---------------------------------------------------------------------------

/**
 * Manages the lifecycle of a single `encore run` process for one discovered
 * Encore application. Each instance is scoped to a specific encore.app root.
 */
export class AppRunner implements vscode.Disposable {
  private readonly onDidChangeStateEmitter = new vscode.EventEmitter<AppState>();
  readonly onDidChangeState = this.onDidChangeStateEmitter.event;

  private readonly onDidUpdateInfoEmitter = new vscode.EventEmitter<AppInfo>();
  readonly onDidUpdateInfo = this.onDidUpdateInfoEmitter.event;

  readonly appRootPath: string;
  readonly displayName: string;

  private readonly outputChannel: vscode.OutputChannel;
  private process: ChildProcess | undefined;
  private state: AppState = AppState.Stopped;
  private info: AppInfo = {};
  private lastOptions: RunOptions | undefined;
  private debugSessionListener: vscode.Disposable | undefined;
  private startTimestamp: number | undefined;
  private bannerSeen = false;
  private preBannerSnapshot = "";

  constructor(appRootPath: string, displayName: string) {
    this.appRootPath = appRootPath;
    this.displayName = displayName;
    this.outputChannel = vscode.window.createOutputChannel(
      `Encore: ${displayName}`,
    );
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  getState(): AppState {
    return this.state;
  }

  getInfo(): AppInfo {
    return { ...this.info };
  }

  showOutput(): void {
    this.outputChannel.show(true);
  }

  async run(options: RunOptions): Promise<void> {
    if (this.state !== AppState.Stopped) {
      return;
    }

    if (!isEncoreCliAvailable()) {
      await promptMissingCli();
      return;
    }

    this.lastOptions = options;
    this.info = {};
    this.bannerSeen = false;
    this.preBannerSnapshot = "";
    this.startTimestamp = Date.now();
    this.outputChannel.clear();
    this.outputChannel.show(true);
    this.setState(AppState.Starting);

    const args = this.buildArgs(options);
    this.outputChannel.appendLine(
      `> cd ${this.appRootPath} && encore ${args.join(" ")}\n`,
    );

    this.process = spawn("encore", args, {
      cwd: this.appRootPath,
      env: buildEncoreEnv(),
      stdio: ["ignore", "pipe", "pipe"],
    });

    this.process.stdout?.on("data", (chunk: Buffer) => {
      const raw = chunk.toString();
      this.appendOutput(raw);
      this.parseOutput(raw, options);
    });

    this.process.stderr?.on("data", (chunk: Buffer) => {
      const raw = chunk.toString();
      this.appendOutput(raw);
      this.parseOutput(raw, options);
    });

    this.process.on("error", (err: Error) => {
      this.flushPreBannerBuffer();
      this.outputChannel.appendLine(`\nProcess error: ${err.message}`);
      this.cleanUp();
      this.setState(AppState.Stopped);
    });

    this.process.on("close", (code: number | null) => {
      const wasStarting = this.state === AppState.Starting;
      const wasRunning = this.state === AppState.Running
        || this.state === AppState.Debugging;

      if (wasStarting) {
        this.flushPreBannerBuffer();
      }

      this.outputChannel.appendLine(
        `\nProcess exited with code ${code ?? "unknown"}`,
      );
      this.cleanUp();
      this.setState(AppState.Stopped);

      if ((wasRunning || wasStarting) && code !== null && code !== 0) {
        const label = wasStarting
          ? `Encore "${this.displayName}" failed to start`
          : `Encore "${this.displayName}" exited with code ${code}`;
        vscode.window
          .showErrorMessage(label, "Show Output", "Restart")
          .then((choice) => {
            if (choice === "Show Output") {
              this.outputChannel.show(true);
            } else if (choice === "Restart" && this.lastOptions) {
              this.run(this.lastOptions);
            }
          });
      }
    });
  }

  async stop(): Promise<void> {
    if (this.state === AppState.Stopped || this.state === AppState.Stopping) {
      return;
    }

    this.setState(AppState.Stopping);

    if (this.debugSessionListener) {
      await vscode.debug.stopDebugging();
    }

    if (this.process && !this.process.killed) {
      this.process.kill("SIGTERM");

      const forceKillTimer = setTimeout(() => {
        if (this.process && !this.process.killed) {
          this.process.kill("SIGKILL");
        }
      }, 5_000);

      this.process.once("close", () => {
        clearTimeout(forceKillTimer);
      });
    } else {
      this.cleanUp();
      this.setState(AppState.Stopped);
    }
  }

  async restart(): Promise<void> {
    const options = this.lastOptions;
    if (!options) {
      return;
    }

    await this.stop();
    await this.waitForState(AppState.Stopped, 10_000);
    await this.run(options);
  }

  dispose(): void {
    if (this.process && !this.process.killed) {
      this.process.kill("SIGTERM");
    }
    this.cleanUp();
    this.onDidChangeStateEmitter.dispose();
    this.onDidUpdateInfoEmitter.dispose();
    this.outputChannel.dispose();
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private buildArgs(options: RunOptions): string[] {
    const args = ["run", "--browser=never"];

    if (options.debug) {
      args.push("--debug=break");
    }

    if (!options.watch) {
      args.push("--watch=false");
    }

    args.push(`--port=${options.port}`);

    if (options.logLevel) {
      args.push(`--level=${options.logLevel}`);
    }

    return args;
  }

  private parseOutput(text: string, options: RunOptions): void {
    const clean = stripAnsi(text);
    let changed = false;

    const stage = extractBuildStage(clean);
    if (stage && stage !== this.info.buildStage) {
      this.info.buildStage = stage;
      changed = true;
    }

    if (!this.info.baseUrl) {
      const urlMatch = clean.match(API_URL_PATTERN);
      if (urlMatch) {
        this.info.baseUrl = urlMatch[1];
        this.info.buildStage = undefined;
        changed = true;
      }
    }

    if (!this.info.dashboardUrl) {
      const dashMatch = clean.match(DASHBOARD_URL_PATTERN);
      if (dashMatch) {
        this.info.dashboardUrl = dashMatch[1];
        changed = true;
      }
    }

    if (!this.info.pid) {
      const pidMatch = clean.match(PROCESS_ID_PATTERN);
      if (pidMatch) {
        this.info.pid = parseInt(pidMatch[1], 10);
        changed = true;
      }
    }

    if (options.debug && !this.info.delvePort) {
      const delveMatch = clean.match(DELVE_READY_PATTERN);
      if (delveMatch) {
        const addrParts = delveMatch[1].split(":");
        this.info.delvePort = parseInt(addrParts[addrParts.length - 1], 10);
        changed = true;
        this.attachDebugger(options);
      }
    }

    if (this.state === AppState.Starting && this.info.baseUrl && !options.debug) {
      this.setState(AppState.Running);
      this.showStartedNotification(options);
    }

    if (changed) {
      this.onDidUpdateInfoEmitter.fire(this.getInfo());
    }
  }

  private showStartedNotification(options: RunOptions): void {
    const elapsed = this.startTimestamp
      ? ((Date.now() - this.startTimestamp) / 1000).toFixed(1)
      : undefined;

    const mode = options.debug ? "debug mode" : `port ${options.port}`;
    const timeStr = elapsed ? ` in ${elapsed}s` : "";
    const message = `Encore "${this.displayName}" started on ${mode}${timeStr}`;

    const actions: string[] = [];
    if (this.info.dashboardUrl) {
      actions.push("Open Dashboard");
    }
    if (this.info.baseUrl) {
      actions.push("Open API");
    }

    vscode.window
      .showInformationMessage(message, ...actions)
      .then((choice) => {
        if (choice === "Open Dashboard" && this.info.dashboardUrl) {
          vscode.env.openExternal(vscode.Uri.parse(this.info.dashboardUrl));
        } else if (choice === "Open API" && this.info.baseUrl) {
          vscode.env.openExternal(vscode.Uri.parse(this.info.baseUrl));
        }
      });
  }

  /**
   * Attach the VS Code Go debugger to the headless delve server started by
   * `encore run --debug=break`. The debug session is opened against the
   * workspace folder that contains the Encore app root; if none matches
   * (app root sits outside all workspace folders), it falls back to the
   * first workspace folder so the Go extension can still operate.
   */
  private async attachDebugger(options: RunOptions): Promise<void> {
    const appUri = vscode.Uri.file(this.appRootPath);
    const workspaceFolder =
      vscode.workspace.getWorkspaceFolder(appUri)
      ?? vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
      return;
    }

    const debugConfig: vscode.DebugConfiguration = {
      type: "go",
      request: "attach",
      name: `Encore "${this.displayName}" (Debug)`,
      mode: "remote",
      remotePath: this.appRootPath,
      host: "127.0.0.1",
      port: this.info.delvePort ?? 2345,
      stopOnEntry: options.stopOnEntry,
    };

    this.debugSessionListener = vscode.debug.onDidTerminateDebugSession(
      (session) => {
        if (session.name === debugConfig.name) {
          this.debugSessionListener?.dispose();
          this.debugSessionListener = undefined;

          if (
            this.state === AppState.Debugging
            && this.process
            && !this.process.killed
          ) {
            this.setState(AppState.Running);
          }
        }
      },
    );

    const started = await vscode.debug.startDebugging(
      workspaceFolder,
      debugConfig,
    );

    if (started) {
      this.setState(AppState.Debugging);
      this.showStartedNotification(options);
    } else {
      this.debugSessionListener?.dispose();
      this.debugSessionListener = undefined;
      this.setState(AppState.Running);
      vscode.window.showWarningMessage(
        `Encore: failed to attach the Go debugger for "${this.displayName}". The application is running without debugging.`,
      );
    }
  }

  private setState(newState: AppState): void {
    if (this.state === newState) {
      return;
    }
    this.state = newState;
    this.onDidChangeStateEmitter.fire(newState);
  }

  private appendOutput(raw: string): void {
    const cleaned = cleanCliOutput(raw);
    if (!cleaned) {
      return;
    }

    if (this.bannerSeen) {
      this.outputChannel.append(cleaned);
      return;
    }

    const bannerIndex = cleaned.indexOf("Encore development server running!");
    if (bannerIndex >= 0) {
      this.bannerSeen = true;
      const fromBanner = cleaned.substring(bannerIndex);
      this.outputChannel.append(fromBanner);
    } else {
      this.preBannerSnapshot = cleaned;
    }
  }

  private flushPreBannerBuffer(): void {
    if (this.preBannerSnapshot) {
      this.outputChannel.append(this.preBannerSnapshot);
      this.preBannerSnapshot = "";
    }
  }

  private cleanUp(): void {
    this.process = undefined;
    this.startTimestamp = undefined;
    this.bannerSeen = false;
    this.preBannerSnapshot = "";
    this.debugSessionListener?.dispose();
    this.debugSessionListener = undefined;
  }

  private waitForState(target: AppState, timeoutMs: number): Promise<void> {
    if (this.state === target) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        listener.dispose();
        resolve();
      }, timeoutMs);

      const listener = this.onDidChangeState((s) => {
        if (s === target) {
          clearTimeout(timer);
          listener.dispose();
          resolve();
        }
      });
    });
  }
}
