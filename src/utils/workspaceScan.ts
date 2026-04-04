import * as path from "path";
import * as vscode from "vscode";

export const GO_FILE_EXCLUDE_GLOB =
  "{**/node_modules/**,**/vendor/**,**/.git/**,**/.*/**}";

export const ENCORE_APP_EXCLUDE_GLOB =
  "{**/node_modules/**,**/.git/**,**/.*/**}";

export function isInHiddenDirectory(filePath: string): boolean {
  const normalisedPath = path.normalize(filePath);
  const pathSegments = normalisedPath.split(path.sep);

  return pathSegments.some((pathSegment) =>
    pathSegment.length > 1
      && pathSegment.startsWith(".")
      && pathSegment !== ".git"
      ? true
      : pathSegment === ".git",
  );
}

export function shouldSkipGoWorkspaceFile(filePath: string): boolean {
  return isInHiddenDirectory(filePath)
    || filePath.endsWith("encore.gen.go")
    || filePath.endsWith("_test.go");
}

export function shouldSkipGeneratedGoFile(filePath: string): boolean {
  return isInHiddenDirectory(filePath)
    || filePath.endsWith("encore.gen.go");
}

export function isVisibleWorkspaceFile(uri: vscode.Uri): boolean {
  return !isInHiddenDirectory(uri.fsPath);
}
