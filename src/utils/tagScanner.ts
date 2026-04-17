import * as vscode from "vscode";

import { DIRECTIVE_RE, TAG_PREFIX } from "../encore/directives";
import { GO_FILE_EXCLUDE_GLOB } from "./workspaceScan";

const TAG_TOKEN_RE = /\btag:(\w+)/g;

/**
 * Scan all Go files in the workspace for tag:<name> tokens in //encore:api directives.
 * Returns a set of unique tag names.
 */
export async function collectWorkspaceTags(): Promise<Set<string>> {
  const tags = new Set<string>();
  const goFiles = await vscode.workspace.findFiles("**/*.go", GO_FILE_EXCLUDE_GLOB);

  for (const fileUri of goFiles) {
    const document = await vscode.workspace.openTextDocument(fileUri);

    for (let i = 0; i < document.lineCount; i++) {
      const line = document.lineAt(i).text;
      if (!DIRECTIVE_RE.test(line)) {
        continue;
      }

      TAG_TOKEN_RE.lastIndex = 0;
      let tagMatch: RegExpExecArray | null;
      while ((tagMatch = TAG_TOKEN_RE.exec(line)) !== null) {
        tags.add(tagMatch[1]);
      }
    }
  }

  return tags;
}
