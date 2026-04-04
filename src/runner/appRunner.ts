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
 *
 * The pattern covers:
 *  - CSI sequences:          ESC [ <params> <letter>
 *  - OSC sequences:          ESC ] ... (ST | BEL)
 *  - Simple two-byte escapes: ESC <letter>  (e.g. ESC 8 for cursor restore)
 *  - Carriage returns
 */
// eslint-disable-next-line no-control-regex
const ANSI_ESCAPE_PATTERN = /\x1b\[[0-9;?]*[A-Za-z]|\x1b\].*?(?:\x07|\x1b\\)|\x1b[0-9A-Za-z]|\r/g;

function stripAnsi(text: string): string {
  return text.replace(ANSI_ESCAPE_PATTERN, "");
}

/**
 * Test whether a line is a spinner-animation frame. After ANSI stripping,
 * spinner lines look like "  ⠴ Building Encore application graph... " but
 * may have leftover digits or whitespace from cursor-control cleanup.
 * Match any line that contains a braille spinner character (U+2800–U+28FF).
 */
const SPINNER_LINE_PATTERN = /[\u2800-\u28FF]/;

/**
 * Clean CLI output for display in a VS Code OutputChannel.
 * Strips ANSI escapes and removes spinner-animation frames entirely,
 * keeping only meaningful output lines.
 */
function cleanCliOutput(text: string): string {
  const stripped = stripAnsi(text);
  const lines = stripped.split("\n");
  const result: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    // Skip empty lines produced by cursor-control cleanup.
    if (trimmed.length === 0) {
      continue;
    }
    // Skip any line containing a braille spinner character.
    if (SPINNER_LINE_PATTERN.test(trimmed)) {
      continue;
    }
    // Skip leftover bare digits from split escape sequences (e.g. "8", "78").
    if (/^\d+$/.test(trimmed)) {
      continue;
    }
    result.push(line);
  }

  return result.length > 0 ? result.join("\n") + "\n" : "";
}

/**
 * Extract build-stage labels from ANSI-stripped text.
 * Returns the last stage label found in the chunk, or undefined.
 */
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
 * Manages the lifecycle of an `encore run` process.
 *
 * Responsibilities:
 *  - Spawn `encore run` with appropriate flags
 *  - Parse stderr to extract base URL, dashboard URL, PID, delve readiness
 *  - Track build stages from CLI spinner output
 *  - Pipe all output to a VS Code OutputChannel
 *  - Emit state-change and info-update events for the tree view
 *  - Auto-attach the VS Code Go debugger when running in debug mode
 *  - Stop (SIGTERM) and restart the process
 */
export class AppRunner implements vscode.Disposable {
  private readonly onDidChangeStateEmitter = new vscode.EventEmitter<AppState>();
  readonly onDidChangeState = this.onDidChangeStateEmitter.event;

  private readonly onDidUpdateInfoEmitter = new vscode.EventEmitter<AppInfo>();
  readonly onDidUpdateInfo = this.onDidUpdateInfoEmitter.event;

  private readonly outputChannel: vscode.OutputChannel;
  private process: ChildProcess | undefined;
  private state: AppState = AppState.Stopped;
  private info: AppInfo = {};
  private lastOptions: RunOptions | undefined;
  private debugSessionListener: vscode.Disposable | undefined;
  private startTimestamp: number | undefined;

  /**
   * Whether the startup banner ("Encore development server running!")
   * has been seen. Before the banner, stderr output is build noise
   * (spinner frames, status lines) and is suppressed from the
   * OutputChannel. After the banner, all output flows through.
   *
   * If the process exits before the banner is seen (build error),
   * the last pre-banner snapshot is flushed so the user can diagnose
   * the failure. Only the latest snapshot is kept because the Encore
   * CLI redraws the entire status block in place using cursor-control
   * codes — each redraw produces a complete copy of the status list.
   */
  private bannerSeen = false;
  private preBannerSnapshot = "";

  constructor(outputChannel: vscode.OutputChannel) {
    this.outputChannel = outputChannel;
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

  /**
   * Start `encore run`. If the application is already running, the call
   * is ignored \u2014 stop first or use restart().
   */
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

    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspaceRoot) {
      vscode.window.showErrorMessage("Encore: no workspace folder found.");
      this.setState(AppState.Stopped);
      return;
    }

    const args = this.buildArgs(options);
    this.outputChannel.appendLine(`> encore ${args.join(" ")}\n`);

    this.process = spawn("encore", args, {
      cwd: workspaceRoot,
      env: buildEncoreEnv(),
      stdio: ["ignore", "pipe", "pipe"],
    });

    this.process.stdout?.on("data", (chunk: Buffer) => {
      this.appendOutput(chunk.toString());
    });

    this.process.stderr?.on("data", (chunk: Buffer) => {
      const raw = chunk.toString();
      this.appendOutput(raw);
      this.parseStderr(raw, options, workspaceRoot);
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

      // If the process died during startup, flush the buffered build
      // output so the user can see what went wrong.
      if (wasStarting) {
        this.flushPreBannerBuffer();
      }

      this.outputChannel.appendLine(
        `\nProcess exited with code ${code ?? "unknown"}`,
      );
      this.cleanUp();
      this.setState(AppState.Stopped);

      // Show a notification on unexpected exit or failed startup.
      if ((wasRunning || wasStarting) && code !== null && code !== 0) {
        const label = wasStarting
          ? "Encore application failed to start"
          : `Encore application exited with code ${code}`;
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

  /** Gracefully stop the running application. */
  async stop(): Promise<void> {
    if (this.state === AppState.Stopped || this.state === AppState.Stopping) {
      return;
    }

    this.setState(AppState.Stopping);

    // Terminate the VS Code debug session first if one is attached.
    if (this.debugSessionListener) {
      await vscode.debug.stopDebugging();
    }

    if (this.process && !this.process.killed) {
      this.process.kill("SIGTERM");

      // If the process does not exit within 5 seconds, force-kill.
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

  /** Stop the running application and start again with the same options. */
  async restart(): Promise<void> {
    const options = this.lastOptions;
    if (!options) {
      return;
    }

    await this.stop();

    // Wait for the process to fully exit before restarting.
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

  /**
   * Parse lines from stderr looking for the Encore banner values
   * and build-stage labels from CLI spinner output.
   */
  private parseStderr(
    text: string,
    options: RunOptions,
    workspaceRoot: string,
  ): void {
    // Strip ANSI escapes before matching — the Encore CLI uses colour
    // codes and cursor-control sequences that break regex matching.
    const clean = stripAnsi(text);
    let changed = false;

    // Extract build stage from spinner lines.
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
        this.attachDebugger(workspaceRoot, options);
      }
    }

    // Transition from Starting \u2192 Running once the base URL is detected.
    if (this.state === AppState.Starting && this.info.baseUrl && !options.debug) {
      this.setState(AppState.Running);
      this.showStartedNotification(options);
    }

    if (changed) {
      this.onDidUpdateInfoEmitter.fire(this.getInfo());
    }
  }

  /**
   * Show a success notification after the application starts successfully.
   * Includes elapsed time and action buttons to open the dashboard or API.
   */
  private showStartedNotification(options: RunOptions): void {
    const elapsed = this.startTimestamp
      ? ((Date.now() - this.startTimestamp) / 1000).toFixed(1)
      : undefined;

    const mode = options.debug ? "debug mode" : `port ${options.port}`;
    const timeStr = elapsed ? ` in ${elapsed}s` : "";
    const message = `Encore application started on ${mode}${timeStr}`;

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
   * Attach the VS Code Go debugger to the headless delve server
   * started by `encore run --debug=break`.
   */
  private async attachDebugger(
    workspaceRoot: string,
    options: RunOptions,
  ): Promise<void> {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
      return;
    }

    const debugConfig: vscode.DebugConfiguration = {
      type: "go",
      request: "attach",
      name: "Encore App (Debug)",
      mode: "remote",
      remotePath: workspaceRoot,
      host: "127.0.0.1",
      port: this.info.delvePort ?? 2345,
      stopOnEntry: options.stopOnEntry,
    };

    // Listen for the debug session ending so the tree view can update.
    this.debugSessionListener = vscode.debug.onDidTerminateDebugSession(
      (session) => {
        if (session.name === debugConfig.name) {
          this.debugSessionListener?.dispose();
          this.debugSessionListener = undefined;

          // Only transition state if the app is still running.
          if (
            this.state === AppState.Debugging &&
            this.process &&
            !this.process.killed
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
      // Debugger failed to attach but the app is still running.
      this.setState(AppState.Running);
      vscode.window.showWarningMessage(
        "Encore: failed to attach the Go debugger. The application is running without debugging.",
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

  /**
   * Route output to the OutputChannel. Before the startup banner is
   * seen, all output is buffered silently (build progress noise).
   * After the banner, output flows through with ANSI codes stripped.
   */
  private appendOutput(raw: string): void {
    const cleaned = cleanCliOutput(raw);
    if (!cleaned) {
      return;
    }

    if (this.bannerSeen) {
      this.outputChannel.append(cleaned);
      return;
    }

    // Check whether the banner appeared in the current chunk.
    const bannerIndex = cleaned.indexOf("Encore development server running!");
    if (bannerIndex >= 0) {
      this.bannerSeen = true;
      // Output only from the banner line onwards.
      const fromBanner = cleaned.substring(bannerIndex);
      this.outputChannel.append(fromBanner);
    } else {
      // Keep only the latest pre-banner snapshot. The Encore CLI
      // redraws the full status block on every update, so each
      // cleaned chunk is a complete replacement, not an addition.
      this.preBannerSnapshot = cleaned;
    }
  }

  /**
   * Flush the last pre-banner snapshot to the OutputChannel.
   * Called when the process dies before the banner is seen
   * so the user can diagnose build failures.
   */
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

  /** Wait until the runner reaches a target state, or timeout. */
  private waitForState(
    target: AppState,
    timeoutMs: number,
  ): Promise<void> {
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
