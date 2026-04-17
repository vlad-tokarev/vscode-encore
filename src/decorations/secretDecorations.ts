import * as vscode from "vscode";
import { SecretEntry, SecretStore } from "../encore/secretStore";
import { debounce } from "../utils/debounce";

const secretEnvDecorationType = vscode.window.createTextEditorDecorationType({
  after: {
    margin: "0 0 0 2em",
    color: new vscode.ThemeColor("editorCodeLens.foreground"),
    fontStyle: "italic",
  },
});

const secretNotDefinedDecorationType = vscode.window.createTextEditorDecorationType({
  after: {
    margin: "0 0 0 2em",
    color: new vscode.ThemeColor("editorWarning.foreground"),
    fontStyle: "italic",
  },
});

interface SecretsStructBlock {
  /** Line index of the opening `var secrets struct {` line. */
  openLine: number;
  /** Line index of the closing `}` line. */
  closeLine: number;
}

/**
 * Find all `var secrets struct { ... }` blocks in the document.
 */
function findSecretsStructBlocks(document: vscode.TextDocument): SecretsStructBlock[] {
  const blocks: SecretsStructBlock[] = [];

  for (let i = 0; i < document.lineCount; i++) {
    const text = document.lineAt(i).text;
    if (!/^\s*var\s+secrets\s+struct\s*\{/.test(text)) {
      continue;
    }

    const openLine = i;
    for (let j = i + 1; j < document.lineCount; j++) {
      const closingText = document.lineAt(j).text;
      if (/^\s*\}\s*$/.test(closingText)) {
        blocks.push({ openLine, closeLine: j });
        i = j;
        break;
      }
    }
  }

  return blocks;
}

/**
 * Build inline decorations for each field inside secrets struct blocks,
 * showing environment availability sourced from SecretStore.
 */
export function updateSecretDecorations(
  editor: vscode.TextEditor,
  secretStore: SecretStore,
): void {
  if (editor.document.languageId !== "go") {
    editor.setDecorations(secretEnvDecorationType, []);
    editor.setDecorations(secretNotDefinedDecorationType, []);
    return;
  }

  const appRootPath = secretStore.getAppRootForFile(editor.document.fileName);
  if (!appRootPath) {
    editor.setDecorations(secretEnvDecorationType, []);
    editor.setDecorations(secretNotDefinedDecorationType, []);
    return;
  }

  if (!secretStore.isAuthenticated()) {
    secretStore.ensureLoadedForFile(editor.document.fileName);
    editor.setDecorations(secretEnvDecorationType, []);
    editor.setDecorations(secretNotDefinedDecorationType, []);
    return;
  }

  const secrets = secretStore.ensureLoaded(appRootPath);
  const secretsByKey = new Map<string, SecretEntry>();
  for (const secret of secrets) {
    secretsByKey.set(secret.key, secret);
  }

  const blocks = findSecretsStructBlocks(editor.document);
  const envDecorations: vscode.DecorationOptions[] = [];
  const notDefinedDecorations: vscode.DecorationOptions[] = [];

  for (const block of blocks) {
    for (let i = block.openLine + 1; i < block.closeLine; i++) {
      const lineText = editor.document.lineAt(i).text;
      const fieldMatch = lineText.match(/^\s*(\w+)\s+string/);
      if (!fieldMatch) {
        continue;
      }

      const fieldName = fieldMatch[1];
      const lineEnd = lineText.length;
      const range = new vscode.Range(i, lineEnd, i, lineEnd);

      const secret = secretsByKey.get(fieldName);
      if (!secret) {
        notDefinedDecorations.push({
          range,
          renderOptions: {
            after: {
              contentText: secretStore.isLoaded(appRootPath)
                ? "secret not defined"
                : "loading...",
            },
          },
        });
        continue;
      }

      const envLabel = buildEnvLabel(secret);
      if (envLabel === null) {
        notDefinedDecorations.push({
          range,
          renderOptions: {
            after: { contentText: "not set in any environment" },
          },
        });
      } else {
        envDecorations.push({
          range,
          renderOptions: {
            after: { contentText: envLabel },
          },
        });
      }
    }
  }

  editor.setDecorations(secretEnvDecorationType, envDecorations);
  editor.setDecorations(secretNotDefinedDecorationType, notDefinedDecorations);
}

/**
 * Register listeners that refresh secret decorations when the active editor
 * or document content changes, or when the secret store reloads.
 */
export function registerSecretDecorations(
  context: vscode.ExtensionContext,
  secretStore: SecretStore,
): void {
  const refresh = () => {
    const editor = vscode.window.activeTextEditor;
    if (editor) {
      updateSecretDecorations(editor, secretStore);
    }
  };

  // Initial decoration pass.
  refresh();

  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(refresh),
    vscode.workspace.onDidChangeTextDocument(
      debounce((event: vscode.TextDocumentChangeEvent) => {
        const activeEditor = vscode.window.activeTextEditor;
        if (activeEditor && event.document === activeEditor.document) {
          updateSecretDecorations(activeEditor, secretStore);
        }
      }, 150),
    ),
    secretStore.onDidChange(refresh),
    secretEnvDecorationType,
    secretNotDefinedDecorationType,
  );
}

function buildEnvLabel(secret: SecretEntry): string | null {
  const parts: string[] = [];
  if (secret.environments.production) { parts.push("Prod"); }
  if (secret.environments.development) { parts.push("Dev"); }
  if (secret.environments.local) { parts.push("Local"); }
  if (secret.environments.preview) { parts.push("Preview"); }
  return parts.length > 0 ? parts.join(" | ") : null;
}
