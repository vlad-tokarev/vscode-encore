import * as vscode from "vscode";

import { STRUCT_METHOD_RE } from "../constants";
import { findWrapperInEncoreGen } from "../utils/encoreGen";
import { normaliseLocations } from "../utils/locations";

let isProcessingReferences = false;

export class EncoreReferenceProvider implements vscode.ReferenceProvider {
  async provideReferences(
    document: vscode.TextDocument,
    position: vscode.Position,
    _context: vscode.ReferenceContext,
    _token: vscode.CancellationToken,
  ): Promise<vscode.Location[] | null> {
    if (isProcessingReferences) {
      return null;
    }

    const line = document.lineAt(position.line).text;
    const structMethodMatch = line.match(STRUCT_METHOD_RE);
    if (!structMethodMatch) {
      return null;
    }

    const methodName = structMethodMatch[1];

    const wrapperLocation = await findWrapperInEncoreGen(
      document.uri.fsPath,
      methodName,
    );

    if (!wrapperLocation) {
      return null;
    }

    isProcessingReferences = true;
    try {
      const rawReferences = await vscode.commands.executeCommand<
        (vscode.Location | vscode.LocationLink)[]
      >(
        "vscode.executeReferenceProvider",
        wrapperLocation.uri,
        wrapperLocation.range.start,
      );

      if (!rawReferences || rawReferences.length === 0) {
        return null;
      }

      return normaliseLocations(rawReferences);
    } finally {
      isProcessingReferences = false;
    }
  }
}
