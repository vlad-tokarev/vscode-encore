import * as vscode from "vscode";
import { SecretStore } from "../encore/secretStore";

/**
 * Provides autocomplete suggestions for field names inside `var secrets struct { ... }` blocks.
 * Secret names are sourced from SecretStore (populated via `encore secret list`).
 */
export class EncoreSecretCompletionProvider
  implements vscode.CompletionItemProvider
{
  private readonly secretStore: SecretStore;

  constructor(secretStore: SecretStore) {
    this.secretStore = secretStore;
  }

  provideCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
  ): vscode.CompletionItem[] | undefined {
    if (!isInsideSecretsStruct(document, position)) {
      return undefined;
    }

    const appRootPath = this.secretStore.getAppRootForFile(document.fileName);
    if (!appRootPath) {
      return undefined;
    }

    if (!this.secretStore.isAuthenticated()) {
      this.secretStore.ensureLoadedForFile(document.fileName);
      return undefined;
    }

    const lineText = document.lineAt(position.line).text;
    const textUpToCursor = lineText.substring(0, position.character).trimStart();

    // Do not suggest field names when the cursor is after the field name (e.g. typing the type).
    if (textUpToCursor.includes(" ")) {
      return undefined;
    }

    const existingFields = collectExistingFieldNames(document, position);
    const secrets = this.secretStore.ensureLoaded(appRootPath);
    const items: vscode.CompletionItem[] = [];

    for (const secret of secrets) {
      if (existingFields.has(secret.key)) {
        continue;
      }

      if (textUpToCursor.length > 0 && !secret.key.startsWith(textUpToCursor)) {
        continue;
      }

      const envSummary = buildEnvSummary(secret.environments);

      const item = new vscode.CompletionItem(
        secret.key,
        vscode.CompletionItemKind.Field,
      );
      item.detail = envSummary;
      item.insertText = `${secret.key} string`;
      item.documentation = new vscode.MarkdownString(
        `Encore secret **${secret.key}**\n\nEnvironments: ${envSummary}`,
      );
      item.sortText = `0_${secret.key}`;

      // Replace the entire line content (trimmed) so we don't duplicate partial text.
      const lineStart = lineText.length - lineText.trimStart().length;
      item.range = new vscode.Range(
        position.line,
        lineStart,
        position.line,
        lineText.trimEnd().length,
      );

      items.push(item);
    }

    return items.length > 0 ? items : undefined;
  }
}

/**
 * Determine whether the cursor is inside a `var secrets struct { ... }` block
 * by scanning backwards for the opening declaration and forwards for the closing brace.
 */
function isInsideSecretsStruct(
  document: vscode.TextDocument,
  position: vscode.Position,
): boolean {
  let openLine = -1;
  for (let i = position.line - 1; i >= 0; i--) {
    const text = document.lineAt(i).text;
    if (/^\s*var\s+secrets\s+struct\s*\{/.test(text)) {
      openLine = i;
      break;
    }
    // Stop scanning if a closing brace is found before the opening declaration —
    // the cursor is outside any secrets struct.
    if (/^\s*\}\s*$/.test(text)) {
      return false;
    }
  }

  if (openLine < 0) {
    return false;
  }

  for (let i = position.line; i < document.lineCount; i++) {
    const text = document.lineAt(i).text;
    if (/^\s*\}\s*$/.test(text)) {
      return true;
    }
    // If another var declaration or func appears, the struct was never closed properly.
    if (/^\s*(var|func|type|const)\s/.test(text) && i !== openLine) {
      return false;
    }
  }

  return false;
}

/**
 * Collect field names already declared in the secrets struct surrounding the cursor,
 * so autocomplete does not suggest duplicates.
 */
function collectExistingFieldNames(
  document: vscode.TextDocument,
  position: vscode.Position,
): Set<string> {
  const fields = new Set<string>();

  // Scan backwards to find the opening line.
  let openLine = -1;
  for (let i = position.line - 1; i >= 0; i--) {
    const text = document.lineAt(i).text;
    if (/^\s*var\s+secrets\s+struct\s*\{/.test(text)) {
      openLine = i;
      break;
    }
  }

  if (openLine < 0) {
    return fields;
  }

  // Scan forward from the line after the opening brace until the closing brace.
  for (let i = openLine + 1; i < document.lineCount; i++) {
    const text = document.lineAt(i).text;
    if (/^\s*\}\s*$/.test(text)) {
      break;
    }
    const fieldMatch = text.match(/^\s*(\w+)\s+string/);
    if (fieldMatch) {
      fields.add(fieldMatch[1]);
    }
  }

  return fields;
}

function buildEnvSummary(
  environments: { production: boolean; development: boolean; local: boolean; preview: boolean },
): string {
  const parts: string[] = [];
  if (environments.production) { parts.push("Prod"); }
  if (environments.development) { parts.push("Dev"); }
  if (environments.local) { parts.push("Local"); }
  if (environments.preview) { parts.push("Preview"); }
  return parts.length > 0 ? parts.join(", ") : "not defined in any environment";
}
