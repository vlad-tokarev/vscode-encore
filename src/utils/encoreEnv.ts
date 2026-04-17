import * as path from "path";
import * as fs from "fs";
import * as vscode from "vscode";

/**
 * Extra directories appended to PATH when spawning CLI subprocesses.
 * Covers the two most common Homebrew / system install locations on
 * macOS and Linux.
 */
const FALLBACK_PATH_DIRS = ["/opt/homebrew/bin", "/usr/local/bin"];

/**
 * Resolve the absolute path to the `encore` binary.
 *
 * Resolution order:
 *  1. User-configured `encore.cliPath` setting (if non-empty).
 *  2. `encore` found on the current PATH (including FALLBACK_PATH_DIRS).
 *
 * Returns `undefined` when the binary cannot be found.
 */
export function resolveEncoreBinary(): string | undefined {
  // 1. Explicit setting takes priority.
  const configuredPath = vscode.workspace
    .getConfiguration("encore")
    .get<string>("cliPath", "")
    .trim();

  if (configuredPath) {
    if (fs.existsSync(configuredPath)) {
      return configuredPath;
    }
    // Setting points to a non-existent file — fall through to PATH search
    // so the user still gets a working extension if `encore` is on PATH.
  }

  // 2. Search PATH + fallback directories.
  const sep = path.delimiter;
  const pathDirs = (process.env.PATH ?? "")
    .split(sep)
    .concat(FALLBACK_PATH_DIRS);

  const binaryName = process.platform === "win32" ? "encore.exe" : "encore";

  for (const dir of pathDirs) {
    if (!dir) {
      continue;
    }
    const candidate = path.join(dir, binaryName);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // Not found in this directory — continue searching.
    }
  }

  return undefined;
}

/**
 * Build the environment variables for spawning Encore CLI commands.
 *
 * Appends common Encore install locations to PATH so the child process
 * can locate the `encore` binary regardless of VS Code's shell
 * configuration.
 */
export function buildEncoreEnv(): NodeJS.ProcessEnv {
  const sep = path.delimiter;
  return {
    ...process.env,
    PATH: `${process.env.PATH}${sep}${FALLBACK_PATH_DIRS.join(sep)}`,
  };
}

/**
 * Check whether the Encore CLI is available. Returns `true` when the
 * binary can be found, `false` otherwise.
 */
export function isEncoreCliAvailable(): boolean {
  return resolveEncoreBinary() !== undefined;
}

/**
 * Show a notification prompting the user to install Encore or configure
 * the `encore.cliPath` setting. Use for critical paths (run, test, daemon)
 * where the CLI is required to proceed.
 */
export async function promptMissingCli(): Promise<void> {
  const choice = await vscode.window.showWarningMessage(
    "Encore CLI not found. Install Encore or set the path in settings.",
    "Install Encore",
    "Open Settings",
  );

  if (choice === "Install Encore") {
    vscode.env.openExternal(
      vscode.Uri.parse("https://encore.dev/docs/go/install"),
    );
  } else if (choice === "Open Settings") {
    vscode.commands.executeCommand(
      "workbench.action.openSettings",
      "encore.cliPath",
    );
  }
}
