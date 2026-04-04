import * as vscode from "vscode";

export function normaliseLocations(
  raw: (vscode.Location | vscode.LocationLink)[],
): vscode.Location[] {
  return raw.map((item) => {
    if (item instanceof vscode.Location) {
      return item;
    }
    const link = item as vscode.LocationLink;
    return new vscode.Location(
      link.targetUri,
      link.targetSelectionRange ?? link.targetRange,
    );
  });
}
