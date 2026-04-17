import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";

import {
  DiscoveredApp,
  discoveredAppsEqual,
  getContainingApp,
} from "./discoveredApps";

export class EncoreAppState implements vscode.Disposable {
  private readonly onDidChangeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.onDidChangeEmitter.event;

  private discoveredApps: DiscoveredApp[] = [];
  private discoveredAppRootPathSet = new Set<string>();
  private nearestGoModuleRootByDirectoryPath = new Map<string, string | null>();

  dispose(): void {
    this.onDidChangeEmitter.dispose();
  }

  setDiscoveredApps(apps: readonly DiscoveredApp[]): void {
    const nextApps = dedupeByRootPath(apps);
    if (discoveredAppsEqual(this.discoveredApps, nextApps)) {
      return;
    }

    this.discoveredApps = nextApps;
    this.discoveredAppRootPathSet = new Set(nextApps.map((app) => app.rootPath));
    this.onDidChangeEmitter.fire();
  }

  getDiscoveredApps(): readonly DiscoveredApp[] {
    return this.discoveredApps;
  }

  getDiscoveredAppRootPaths(): readonly string[] {
    return this.discoveredApps.map((app) => app.rootPath);
  }

  invalidateGoModuleBoundaries(): void {
    this.nearestGoModuleRootByDirectoryPath.clear();
    this.onDidChangeEmitter.fire();
  }

  async hasDiscoveredAppRootForFile(filePath: string): Promise<boolean> {
    return (await this.getDiscoveredAppRootForFile(filePath)) !== undefined;
  }

  async getDiscoveredAppRootForFile(filePath: string): Promise<string | undefined> {
    const app = await this.getDiscoveredAppForFile(filePath);
    return app?.rootPath;
  }

  async getDiscoveredAppForFile(filePath: string): Promise<DiscoveredApp | undefined> {
    const resolvedFilePath = path.resolve(filePath);
    const nearestGoModuleRootPath = await findNearestGoModuleRootPath(
      path.dirname(resolvedFilePath),
      this.nearestGoModuleRootByDirectoryPath,
    );

    if (nearestGoModuleRootPath) {
      if (!this.discoveredAppRootPathSet.has(nearestGoModuleRootPath)) {
        return undefined;
      }
      return this.discoveredApps.find(
        (app) => app.rootPath === nearestGoModuleRootPath,
      );
    }

    return getContainingApp(resolvedFilePath, this.discoveredApps);
  }
}

function dedupeByRootPath(apps: readonly DiscoveredApp[]): DiscoveredApp[] {
  const byRoot = new Map<string, DiscoveredApp>();
  for (const app of apps) {
    const resolvedRoot = path.resolve(app.rootPath);
    if (!byRoot.has(resolvedRoot)) {
      byRoot.set(resolvedRoot, { ...app, rootPath: resolvedRoot });
    }
  }
  return [...byRoot.values()].sort((a, b) =>
    a.displayName.localeCompare(b.displayName) || a.rootPath.localeCompare(b.rootPath),
  );
}

async function findNearestGoModuleRootPath(
  currentPath: string,
  nearestGoModuleRootByDirectoryPath: Map<string, string | null>,
): Promise<string | undefined> {
  const visitedDirectoryPaths: string[] = [];
  let searchPath = currentPath;

  while (true) {
    const cachedGoModuleRootPath = nearestGoModuleRootByDirectoryPath.get(searchPath);
    if (cachedGoModuleRootPath !== undefined) {
      cacheNearestGoModuleRootPath(
        visitedDirectoryPaths,
        cachedGoModuleRootPath ?? undefined,
        nearestGoModuleRootByDirectoryPath,
      );
      return cachedGoModuleRootPath ?? undefined;
    }

    visitedDirectoryPaths.push(searchPath);
    if (await pathExists(path.join(searchPath, "go.mod"))) {
      cacheNearestGoModuleRootPath(
        visitedDirectoryPaths,
        searchPath,
        nearestGoModuleRootByDirectoryPath,
      );
      return searchPath;
    }

    const parentPath = path.dirname(searchPath);
    if (parentPath === searchPath) {
      cacheNearestGoModuleRootPath(
        visitedDirectoryPaths,
        undefined,
        nearestGoModuleRootByDirectoryPath,
      );
      return undefined;
    }

    searchPath = parentPath;
  }
}

function cacheNearestGoModuleRootPath(
  visitedDirectoryPaths: readonly string[],
  goModuleRootPath: string | undefined,
  nearestGoModuleRootByDirectoryPath: Map<string, string | null>,
): void {
  for (const visitedDirectoryPath of visitedDirectoryPaths) {
    nearestGoModuleRootByDirectoryPath.set(visitedDirectoryPath, goModuleRootPath ?? null);
  }
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.promises.access(targetPath, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}
