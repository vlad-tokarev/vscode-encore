import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";

import { ENCORE_APP_EXCLUDE_GLOB } from "./workspaceScan";

export interface DiscoveredApp {
  rootPath: string;
  displayName: string;
  encoreAppPath: string;
  /** Set when the encore.app file could not be parsed. */
  statusMessage?: string;
}

export async function findEncoreAppFiles(): Promise<vscode.Uri[]> {
  return vscode.workspace.findFiles("**/encore.app", ENCORE_APP_EXCLUDE_GLOB);
}

export function buildDiscoveredApp(encoreAppPath: string): DiscoveredApp {
  const rootPath = path.dirname(encoreAppPath);
  const fallbackDisplayName = path.basename(rootPath) || "Encore App";

  try {
    const raw = fs.readFileSync(encoreAppPath, "utf-8");
    const stripped = raw.replace(/"(?:[^"\\]|\\.)*"|\/\/.*$/gm, (match) =>
      match.startsWith('"') ? match : "",
    );
    const parsed = JSON.parse(stripped);
    const displayName =
      typeof parsed.id === "string" && parsed.id.length > 0
        ? parsed.id
        : fallbackDisplayName;

    return {
      rootPath,
      displayName,
      encoreAppPath,
    };
  } catch {
    return {
      rootPath,
      displayName: fallbackDisplayName,
      encoreAppPath,
      statusMessage: "encore.app could not be parsed",
    };
  }
}

export async function discoverApps(): Promise<DiscoveredApp[]> {
  const files = await findEncoreAppFiles();
  const apps = files.map((file) => buildDiscoveredApp(file.fsPath));
  return apps.sort(compareDiscoveredApps);
}

export function compareDiscoveredApps(a: DiscoveredApp, b: DiscoveredApp): number {
  return a.displayName.localeCompare(b.displayName) || a.rootPath.localeCompare(b.rootPath);
}

export function discoveredAppsEqual(
  left: readonly DiscoveredApp[],
  right: readonly DiscoveredApp[],
): boolean {
  if (left.length !== right.length) {
    return false;
  }

  for (let i = 0; i < left.length; i++) {
    const a = left[i];
    const b = right[i];
    if (
      a.rootPath !== b.rootPath
      || a.displayName !== b.displayName
      || a.encoreAppPath !== b.encoreAppPath
      || a.statusMessage !== b.statusMessage
    ) {
      return false;
    }
  }

  return true;
}

export function isPathInsideAppRoot(
  candidatePath: string,
  appRootPath: string,
): boolean {
  const relativePath = path.relative(appRootPath, candidatePath);
  return relativePath === ""
    || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));
}

/**
 * Return the most specific app whose root contains the given file path, or
 * undefined if no discovered app contains it.
 */
export function getContainingApp(
  filePath: string,
  apps: readonly DiscoveredApp[],
): DiscoveredApp | undefined {
  const resolved = path.resolve(filePath);
  let matched: DiscoveredApp | undefined;

  for (const app of apps) {
    if (!isPathInsideAppRoot(resolved, app.rootPath)) {
      continue;
    }
    if (!matched || app.rootPath.length > matched.rootPath.length) {
      matched = app;
    }
  }

  return matched;
}
