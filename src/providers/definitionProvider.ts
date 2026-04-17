import * as vscode from "vscode";
import * as fs from "fs";

import {
  isEncoreGenFile,
  extractFuncName,
  findSourceDefinition,
} from "../utils/encoreGen";
import { normaliseLocations } from "../utils/locations";

let isProcessingDefinition = false;

export class EncoreDefinitionProvider implements vscode.DefinitionProvider {
  async provideDefinition(
    document: vscode.TextDocument,
    position: vscode.Position,
    _token: vscode.CancellationToken,
  ): Promise<vscode.Definition | null> {
    if (isProcessingDefinition) {
      return null;
    }

    isProcessingDefinition = true;
    try {
      const rawDefinitions = await vscode.commands.executeCommand<
        (vscode.Location | vscode.LocationLink)[]
      >("vscode.executeDefinitionProvider", document.uri, position);

      if (!rawDefinitions || rawDefinitions.length === 0) {
        return null;
      }

      const locations = normaliseLocations(rawDefinitions);
      const hasEncoreGen = locations.some((loc) =>
        isEncoreGenFile(loc.uri.fsPath),
      );

      if (!hasEncoreGen) {
        return null;
      }

      const redirected: vscode.Location[] = [];

      for (const loc of locations) {
        if (!isEncoreGenFile(loc.uri.fsPath)) {
          redirected.push(loc);
          continue;
        }

        let genContent: string;
        try {
          genContent = await fs.promises.readFile(loc.uri.fsPath, "utf-8");
        } catch {
          redirected.push(loc);
          continue;
        }

        const genLines = genContent.split("\n");
        const funcName = extractFuncName(genLines, loc.range.start.line);

        if (!funcName) {
          redirected.push(loc);
          continue;
        }

        const sourceLocation = await findSourceDefinition(
          loc.uri.fsPath,
          funcName,
        );
        redirected.push(sourceLocation ?? loc);
      }

      return redirected;
    } finally {
      isProcessingDefinition = false;
    }
  }
}
