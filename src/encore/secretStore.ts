import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { exec } from "child_process";

import { buildEncoreEnv, isEncoreCliAvailable } from "../utils/encoreEnv";

export interface SecretEnvironments {
  production: boolean;
  development: boolean;
  local: boolean;
  preview: boolean;
}

export interface SecretEntry {
  key: string;
  environments: SecretEnvironments;
}

export interface EncoreCloudAuthStatus {
  state: "unknown" | "authenticated" | "unauthenticated";
  username?: string;
  message: string;
}

const CACHE_FILE_NAME = "encore-secrets-cache.json";

interface SecretAppState {
  entries: SecretEntry[];
  loaded: boolean;
  loading: boolean;
}

type SecretCacheFileContents = Record<string, SecretEntry[]>;

/**
 * Centralised store for Encore Cloud auth status and secrets loaded via CLI commands.
 * TreeView, autocomplete providers, and decoration providers can read from the same
 * in-memory cache without re-running the CLI command on every access.
 *
 * The store checks `encore auth whoami` before loading secrets. Secret data is restored
 * from the disk cache only for an authenticated Encore Cloud session.
 */
export class SecretStore {
  private readonly onDidChangeEmitter = new vscode.EventEmitter<void>();
  /** Fires after the secret list has been refreshed (successfully or not). */
  readonly onDidChange = this.onDidChangeEmitter.event;

  private authLoading = false;
  private readonly workspaceRoot: string | undefined;
  private readonly cachePath: string | undefined;
  private discoveredAppRoots: string[] = [];
  private appStates = new Map<string, SecretAppState>();
  private authStatus: EncoreCloudAuthStatus = {
    state: "unknown",
    message: "Checking Encore Cloud login…",
  };

  constructor(globalStorageUri: vscode.Uri) {
    this.workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    this.cachePath = path.join(globalStorageUri.fsPath, CACHE_FILE_NAME);
    this.refreshAuthStatus();
  }

  setDiscoveredAppRoots(appRootPaths: readonly string[]): void {
    const nextAppRoots = [...new Set(appRootPaths)].sort((left, right) =>
      left.localeCompare(right),
    );

    if (stringArraysEqual(this.discoveredAppRoots, nextAppRoots)) {
      return;
    }

    const nextAppStates = new Map<string, SecretAppState>();
    for (const appRootPath of nextAppRoots) {
      nextAppStates.set(appRootPath, this.appStates.get(appRootPath) ?? createEmptySecretAppState());
    }

    this.discoveredAppRoots = nextAppRoots;
    this.appStates = nextAppStates;

    if (this.isAuthenticated()) {
      this.restoreFromDiskCache();
    }

    this.onDidChangeEmitter.fire();
  }

  /** All cached secrets for the given Encore app root. Returns an empty array before the first load completes. */
  getSecrets(appRootPath: string): readonly SecretEntry[] {
    return this.getAppState(appRootPath).entries;
  }

  /** Secret key names only — useful for autocomplete providers. */
  getSecretKeys(appRootPath: string): string[] {
    return this.getSecrets(appRootPath).map((entry) => entry.key);
  }

  getSecretsForFile(filePath: string): readonly SecretEntry[] {
    const appRootPath = this.getAppRootForFile(filePath);
    if (!appRootPath) {
      return [];
    }

    return this.getSecrets(appRootPath);
  }

  getAppRootForFile(filePath: string): string | undefined {
    let matchedAppRootPath: string | undefined;

    for (const appRootPath of this.discoveredAppRoots) {
      if (!isPathInsideAppRoot(filePath, appRootPath)) {
        continue;
      }

      if (!matchedAppRootPath || appRootPath.length > matchedAppRootPath.length) {
        matchedAppRootPath = appRootPath;
      }
    }

    return matchedAppRootPath;
  }

  getAuthStatus(): Readonly<EncoreCloudAuthStatus> {
    return this.authStatus;
  }

  isAuthenticated(): boolean {
    return this.authStatus.state === "authenticated";
  }

  isLoaded(appRootPath: string): boolean {
    return this.getAppState(appRootPath).loaded;
  }

  isLoadedForFile(filePath: string): boolean {
    const appRootPath = this.getAppRootForFile(filePath);
    if (!appRootPath) {
      return false;
    }

    return this.isLoaded(appRootPath);
  }

  /**
   * Trigger an auth refresh and reload secrets for an authenticated session.
   * Concurrent requests are coalesced.
   */
  refresh(): void {
    this.refreshAuthStatus();

    if (this.isAuthenticated()) {
      this.loadKnownAppSecrets(true);
    }
  }

  refreshAuthStatus(): void {
    this.loadAuthStatusFromCli();
  }

  /**
   * Return cached secrets if available, otherwise kick off an auth-aware load
   * and return an empty array. Consumers should listen to onDidChange.
   */
  ensureLoaded(appRootPath: string): readonly SecretEntry[] {
    if (this.authStatus.state === "unknown") {
      this.refreshAuthStatus();
      return this.getSecrets(appRootPath);
    }

    if (!this.isAuthenticated()) {
      return [];
    }

    const appState = this.getAppState(appRootPath);
    if (!appState.loaded && !appState.loading) {
      this.loadSecretsFromCli(appRootPath);
    }
    return appState.entries;
  }

  ensureLoadedForFile(filePath: string): readonly SecretEntry[] {
    const appRootPath = this.getAppRootForFile(filePath);
    if (!appRootPath) {
      return [];
    }

    return this.ensureLoaded(appRootPath);
  }

  private loadAuthStatusFromCli(): void {
    const cwd = this.workspaceRoot;
    if (!cwd) {
      const nextAuthStatus: EncoreCloudAuthStatus = {
        state: "unauthenticated",
        message: "Open an Encore workspace",
      };

      if (!authStatusesEqual(this.authStatus, nextAuthStatus)) {
        this.authStatus = nextAuthStatus;
        this.clearSecretsForSignedOutSession();
        this.onDidChangeEmitter.fire();
      }
      return;
    }

    if (!isEncoreCliAvailable()) {
      const nextAuthStatus: EncoreCloudAuthStatus = {
        state: "unauthenticated",
        message: "Encore CLI not found",
      };

      if (!authStatusesEqual(this.authStatus, nextAuthStatus)) {
        this.authStatus = nextAuthStatus;
        this.clearSecretsForSignedOutSession();
        this.onDidChangeEmitter.fire();
      }
      return;
    }

    if (this.authLoading) {
      return;
    }

    this.authLoading = true;
    const previousAuthStatus = this.authStatus;

    exec("encore auth whoami", { timeout: 15_000, cwd, env: buildEncoreEnv() }, (error, stdout) => {
      this.authLoading = false;

      const nextAuthStatus = parseWhoAmIOutput(stdout, error);
      const authChanged = !authStatusesEqual(previousAuthStatus, nextAuthStatus);
      this.authStatus = nextAuthStatus;

      if (!this.isAuthenticated()) {
        this.clearSecretsForSignedOutSession();
        if (authChanged) {
          this.onDidChangeEmitter.fire();
        }
        return;
      }

      this.restoreFromDiskCache();
      if (this.discoveredAppRoots.length > 0) {
        this.loadKnownAppSecrets(false);
      } else if (authChanged) {
        this.onDidChangeEmitter.fire();
      }
    });
  }

  private loadKnownAppSecrets(forceRefresh: boolean): void {
    for (const appRootPath of this.discoveredAppRoots) {
      const appState = this.getAppState(appRootPath);

      if (!forceRefresh && (appState.loaded || appState.loading)) {
        continue;
      }

      if (appState.loading) {
        continue;
      }

      this.loadSecretsFromCli(appRootPath);
    }
  }

  private loadSecretsFromCli(appRootPath: string): void {
    if (!appRootPath) {
      return;
    }

    const appState = this.getAppState(appRootPath);
    appState.loading = true;

    exec("encore secret list", { timeout: 15_000, cwd: appRootPath, env: buildEncoreEnv() }, (error, stdout) => {
      appState.loading = false;

      if (error) {
        appState.entries = [];
      } else {
        appState.entries = parseSecretListOutput(stdout);
        this.writeDiskCache();
      }

      appState.loaded = true;
      this.onDidChangeEmitter.fire();
    });
  }

  private clearSecretsForSignedOutSession(): void {
    for (const appState of this.appStates.values()) {
      appState.entries = [];
      appState.loaded = false;
      appState.loading = false;
    }
  }

  /** Restore the previous secret list from disk so the UI is populated instantly. */
  private restoreFromDiskCache(): void {
    if (!this.cachePath) {
      return;
    }

    try {
      const raw = fs.readFileSync(this.cachePath, "utf-8");
      const parsed = JSON.parse(raw);

      if (Array.isArray(parsed)) {
        if (this.discoveredAppRoots.length === 1) {
          const appState = this.getAppState(this.discoveredAppRoots[0]);
          appState.entries = parsed as SecretEntry[];
          appState.loaded = true;
          this.onDidChangeEmitter.fire();
        }
        return;
      }

      if (typeof parsed !== "object" || parsed === null) {
        return;
      }

      let restoredAnyEntries = false;
      for (const appRootPath of this.discoveredAppRoots) {
        const cachedEntries = (parsed as SecretCacheFileContents)[appRootPath];
        if (!Array.isArray(cachedEntries)) {
          continue;
        }

        const appState = this.getAppState(appRootPath);
        appState.entries = cachedEntries;
        appState.loaded = true;
        restoredAnyEntries = true;
      }

      if (restoredAnyEntries) {
        this.onDidChangeEmitter.fire();
      }
    } catch {
      // No cache file or corrupt data — will be populated after CLI load.
    }
  }

  /** Persist the current secret list to disk for instant restore on next activation. */
  private writeDiskCache(): void {
    if (!this.cachePath) {
      return;
    }

    try {
      const dir = path.dirname(this.cachePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      const cacheContents: SecretCacheFileContents = {};
      for (const [appRootPath, appState] of this.appStates) {
        if (appState.entries.length === 0) {
          continue;
        }
        cacheContents[appRootPath] = appState.entries;
      }

      fs.writeFileSync(this.cachePath, JSON.stringify(cacheContents), "utf-8");
    } catch {
      // Non-critical — the extension works fine without a cache file.
    }
  }

  private getAppState(appRootPath: string): SecretAppState {
    let appState = this.appStates.get(appRootPath);
    if (!appState) {
      appState = createEmptySecretAppState();
      this.appStates.set(appRootPath, appState);
    }
    return appState;
  }

  dispose(): void {
    this.onDidChangeEmitter.dispose();
  }
}

function createEmptySecretAppState(): SecretAppState {
  return {
    entries: [],
    loaded: false,
    loading: false,
  };
}

function authStatusesEqual(
  left: EncoreCloudAuthStatus,
  right: EncoreCloudAuthStatus,
): boolean {
  return left.state === right.state
    && left.username === right.username
    && left.message === right.message;
}

function parseWhoAmIOutput(
  stdout: string,
  error: Error | null,
): EncoreCloudAuthStatus {
  const trimmedOutput = stdout.trim();
  const match = trimmedOutput.match(/^logged in as\s+(.+)$/im);

  if (!error && match) {
    const username = match[1].trim();
    return {
      state: "authenticated",
      username,
      message: `logged in as ${username}`,
    };
  }

  return {
    state: "unauthenticated",
    message: "You are not authenticated",
  };
}

function isPathInsideAppRoot(targetPath: string, appRootPath: string): boolean {
  const relativePath = path.relative(appRootPath, targetPath);
  return relativePath === ""
    || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));
}

function stringArraysEqual(left: readonly string[], right: readonly string[]): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * Parse the tabular output of `encore secret list` into structured SecretEntry objects.
 *
 * Expected format (columns separated by whitespace):
 *   Secret Key        Production   Development   Local   Preview   Specific Envs
 *   MySecret          ✓            ✓             ✗       ✓         staging,production
 */
export function parseSecretListOutput(output: string): SecretEntry[] {
  const lines = output.split("\n").filter((line) => line.trim().length > 0);
  if (lines.length < 2) {
    return [];
  }

  const headerLine = lines[0];
  const productionIdx = headerLine.indexOf("Production");
  const developmentIdx = headerLine.indexOf("Development");
  const localIdx = headerLine.indexOf("Local");
  const previewIdx = headerLine.indexOf("Preview");

  if (productionIdx < 0 || developmentIdx < 0 || localIdx < 0 || previewIdx < 0) {
    return [];
  }

  const secrets: SecretEntry[] = [];

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.length < previewIdx) {
      continue;
    }

    const key = line.substring(0, productionIdx).trim();
    if (key.length === 0) {
      continue;
    }

    const productionVal = line.substring(productionIdx, developmentIdx).trim();
    const developmentVal = line.substring(developmentIdx, localIdx).trim();
    const localVal = line.substring(localIdx, previewIdx).trim();
    const previewVal = line.substring(previewIdx, previewIdx + 10).trim();

    secrets.push({
      key,
      environments: {
        production: productionVal.includes("\u2713"),
        development: developmentVal.includes("\u2713"),
        local: localVal.includes("\u2713"),
        preview: previewVal.includes("\u2713"),
      },
    });
  }

  return secrets;
}
