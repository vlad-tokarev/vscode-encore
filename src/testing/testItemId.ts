import * as vscode from "vscode";

export type EncoreTestItemKind =
  | "module"
  | "package"
  | "file"
  | "test"
  | "benchmark"
  | "fuzz";

export function createEncoreTestItemId(
  uri: vscode.Uri,
  kind: EncoreTestItemKind,
  name?: string,
): string {
  return uri.with({
    query: kind,
    fragment: name ?? "",
  }).toString();
}

export function parseEncoreTestItemId(
  id: string,
): { kind: EncoreTestItemKind; name?: string } {
  const parsedUri = vscode.Uri.parse(id);
  return {
    kind: parsedUri.query as EncoreTestItemKind,
    name: parsedUri.fragment || undefined,
  };
}

export function clearEncoreTestItemMetadata(uri: vscode.Uri): vscode.Uri {
  return uri.with({
    query: "",
    fragment: "",
  });
}
