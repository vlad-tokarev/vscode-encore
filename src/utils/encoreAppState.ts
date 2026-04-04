import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";

export class EncoreAppState implements vscode.Disposable {
  private readonly onDidChangeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.onDidChangeEmitter.event;

  private discoveredAppRootPaths: string[] = [];
  private discoveredAppRootPathSet = new Set<string>();
  private nearestGoModuleRootByDirectoryPath = new Map<string, string | null>();

  dispose(): void {
    this.onDidChangeEmitter.dispose();
  }

  setDiscoveredAppRootPaths(appRootPaths: readonly string[]): void {
    const nextAppRootPaths = [...new Set(
      appRootPaths.map((appRootPath) => path.resolve(appRootPath)),
    )].sort((left, right) => left.localeCompare(right));

    if (stringArraysEqual(this.discoveredAppRootPaths, nextAppRootPaths)) {
      return;
    }

    this.discoveredAppRootPaths = nextAppRootPaths;
    this.discoveredAppRootPathSet = new Set(nextAppRootPaths);
    this.onDidChangeEmitter.fire();
  }

  invalidateGoModuleBoundaries(): void {
    this.nearestGoModuleRootByDirectoryPath.clear();
    this.onDidChangeEmitter.fire();
  }

  async hasDiscoveredAppRootForFile(filePath: string): Promise<boolean> {
    return (await this.getDiscoveredAppRootForFile(filePath)) !== undefined;
  }

  async getDiscoveredAppRootForFile(filePath: string): Promise<string | undefined> {
    const resolvedFilePath = path.resolve(filePath);
    const nearestGoModuleRootPath = await findNearestGoModuleRootPath(
      path.dirname(resolvedFilePath),
      this.nearestGoModuleRootByDirectoryPath,
    );

    if (nearestGoModuleRootPath) {
      return this.discoveredAppRootPathSet.has(nearestGoModuleRootPath)
        ? nearestGoModuleRootPath
        : undefined;
    }

    return getContainingAppRootPath(resolvedFilePath, this.discoveredAppRootPaths);
  }
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

function getContainingAppRootPath(
  targetPath: string,
  discoveredAppRootPaths: readonly string[],
): string | undefined {
  let matchedAppRootPath: string | undefined;

  for (const appRootPath of discoveredAppRootPaths) {
    if (!isPathInsideAppRoot(targetPath, appRootPath)) {
      continue;
    }

    if (!matchedAppRootPath || appRootPath.length > matchedAppRootPath.length) {
      matchedAppRootPath = appRootPath;
    }
  }

  return matchedAppRootPath;
}

function isPathInsideAppRoot(targetPath: string, appRootPath: string): boolean {
  const relativePath = path.relative(appRootPath, targetPath);
  return relativePath === ""
    || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));
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

function stringArraysEqual(left: readonly string[], right: readonly string[]): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
