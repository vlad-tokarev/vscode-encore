import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";

import {
  ENCORE_GEN_FILENAME,
  GENERATED_FUNC_RE,
  INTERFACE_METHOD_RE,
} from "../constants";
import { buildMethodRegex, escapeRegex } from "./regex";

export function isEncoreGenFile(filePath: string): boolean {
  return path.basename(filePath) === ENCORE_GEN_FILENAME;
}

export function extractFuncName(
  lines: string[],
  lineIndex: number,
): string | null {
  const line = lines[lineIndex];
  if (!line) {
    return null;
  }

  const funcMatch = line.match(GENERATED_FUNC_RE);
  if (funcMatch) {
    return funcMatch[1];
  }

  const methodMatch = line.match(INTERFACE_METHOD_RE);
  if (methodMatch) {
    return methodMatch[1];
  }

  return null;
}

/**
 * Scans all .go files in the same directory as encoreGenPath (excluding
 * encore.gen.go) and returns the location of the struct method or
 * standalone function matching funcName.
 */
export async function findSourceDefinition(
  encoreGenPath: string,
  funcName: string,
): Promise<vscode.Location | null> {
  const dirPath = path.dirname(encoreGenPath);
  const methodRegex = buildMethodRegex(funcName);
  const standaloneFuncRegex = new RegExp(
    `^func\\s+${escapeRegex(funcName)}\\s*\\(`,
  );

  const goFiles = await vscode.workspace.findFiles(
    new vscode.RelativePattern(dirPath, "*.go"),
  );

  let fallbackLocation: vscode.Location | null = null;

  for (const fileUri of goFiles) {
    if (isEncoreGenFile(fileUri.fsPath)) {
      continue;
    }

    let content: string;
    try {
      content = await fs.promises.readFile(fileUri.fsPath, "utf-8");
    } catch {
      continue;
    }

    const fileLines = content.split("\n");
    for (let i = 0; i < fileLines.length; i++) {
      const fileLine = fileLines[i];

      if (methodRegex.test(fileLine)) {
        return new vscode.Location(fileUri, new vscode.Position(i, 0));
      }

      if (!fallbackLocation && standaloneFuncRegex.test(fileLine)) {
        fallbackLocation = new vscode.Location(
          fileUri,
          new vscode.Position(i, 0),
        );
      }
    }
  }

  return fallbackLocation;
}

/**
 * Finds the wrapper function location in encore.gen.go for a given method
 * name. Returns the position of "func MethodName(" in encore.gen.go, or
 * null if no wrapper exists.
 */
export async function findWrapperInEncoreGen(
  documentPath: string,
  methodName: string,
): Promise<vscode.Location | null> {
  const dirPath = path.dirname(documentPath);
  const encoreGenPath = path.join(dirPath, ENCORE_GEN_FILENAME);

  let content: string;
  try {
    content = await fs.promises.readFile(encoreGenPath, "utf-8");
  } catch {
    return null;
  }

  const wrapperRe = new RegExp(
    `^func\\s+${escapeRegex(methodName)}\\s*\\(`,
  );
  const lines = content.split("\n");

  for (let i = 0; i < lines.length; i++) {
    if (wrapperRe.test(lines[i])) {
      const nameStart = lines[i].indexOf(methodName);
      return new vscode.Location(
        vscode.Uri.file(encoreGenPath),
        new vscode.Position(i, nameStart >= 0 ? nameStart : 0),
      );
    }
  }

  return null;
}
