import * as vscode from "vscode";

import {
  ACCESS_MODIFIERS,
  DIRECTIVE_RE,
  DIRECTIVES_WITH_TAGS,
  FIELD_NAMES,
  HTTP_METHODS,
  KNOWN_DIRECTIVES,
  TAG_PREFIX,
  getAllOptions,
} from "../encore/directives";
import { debounce } from "../utils/debounce";

function validateDirectiveLine(
  line: string,
  lineIndex: number,
  diagnostics: vscode.Diagnostic[],
): void {
  const match = line.match(DIRECTIVE_RE);
  if (!match || match.index === undefined) {
    return;
  }

  const directiveName = match[1];
  const directiveStart = match.index;

  if (!KNOWN_DIRECTIVES.has(directiveName)) {
    diagnostics.push(
      new vscode.Diagnostic(
        new vscode.Range(
          lineIndex,
          directiveStart,
          lineIndex,
          directiveStart + match[0].length,
        ),
        `Unknown Encore directive "encore:${directiveName}". Valid directives: ${[...KNOWN_DIRECTIVES].join(", ")}.`,
        vscode.DiagnosticSeverity.Error,
      ),
    );
    return;
  }

  const allOptions = getAllOptions(directiveName);
  const allowedFields = FIELD_NAMES[directiveName];
  if (!allowedFields) {
    return;
  }

  const accessModifiers = ACCESS_MODIFIERS[directiveName] ?? new Set();
  const restStart = directiveStart + match[0].length;
  const restText = line.substring(restStart);
  const tokenRe = /\S+/g;
  const seenOptions = new Set<string>();
  const seenFields = new Set<string>();
  let isFirstToken = true;

  let tokenMatch: RegExpExecArray | null;
  while ((tokenMatch = tokenRe.exec(restText)) !== null) {
    const token = tokenMatch[0];
    const tokenStart = restStart + tokenMatch.index;
    const tokenEnd = tokenStart + token.length;
    const tokenRange = new vscode.Range(
      lineIndex,
      tokenStart,
      lineIndex,
      tokenEnd,
    );

    const equalsIndex = token.indexOf("=");

    if (equalsIndex === -1) {
      if (isFirstToken && accessModifiers.size > 0 && !accessModifiers.has(token)) {
        diagnostics.push(
          new vscode.Diagnostic(
            tokenRange,
            `Access modifier must be the first option in encore:${directiveName}. Valid access modifiers: ${[...accessModifiers].join(", ")}.`,
            vscode.DiagnosticSeverity.Error,
          ),
        );
      } else if (!isFirstToken && accessModifiers.has(token)) {
        diagnostics.push(
          new vscode.Diagnostic(
            tokenRange,
            `Access modifier "${token}" must be the first option in encore:${directiveName}.`,
            vscode.DiagnosticSeverity.Error,
          ),
        );
      } else {
        validateBareToken(
          token,
          tokenRange,
          directiveName,
          allOptions,
          allowedFields,
          seenOptions,
          diagnostics,
        );
      }
    } else {
      validateFieldToken(
        token,
        equalsIndex,
        tokenStart,
        lineIndex,
        directiveName,
        allowedFields,
        seenFields,
        diagnostics,
      );
    }
    isFirstToken = false;
  }

  if (accessModifiers.size > 0) {
    const usedAccessModifiers = [...seenOptions].filter((opt) => accessModifiers.has(opt));
    if (usedAccessModifiers.length > 1) {
      diagnostics.push(
        new vscode.Diagnostic(
          new vscode.Range(
            lineIndex,
            directiveStart,
            lineIndex,
            directiveStart + line.substring(directiveStart).length,
          ),
          `Access modifiers ${usedAccessModifiers.map((o) => `"${o}"`).join(" and ")} are mutually exclusive in encore:${directiveName}.`,
          vscode.DiagnosticSeverity.Error,
        ),
      );
    }
  }
}

function validateBareToken(
  token: string,
  tokenRange: vscode.Range,
  directiveName: string,
  allowedOptions: Set<string>,
  allowedFields: Set<string>,
  seenOptions: Set<string>,
  diagnostics: vscode.Diagnostic[],
): void {
  if (token.startsWith("/")) {
    return;
  }

  if (token.startsWith(TAG_PREFIX)) {
    if (!DIRECTIVES_WITH_TAGS.has(directiveName)) {
      diagnostics.push(
        new vscode.Diagnostic(
          tokenRange,
          `Tags are not supported on encore:${directiveName}. Tags can only be used with: ${[...DIRECTIVES_WITH_TAGS].join(", ")}.`,
          vscode.DiagnosticSeverity.Error,
        ),
      );
    } else if (token.length <= TAG_PREFIX.length) {
      diagnostics.push(
        new vscode.Diagnostic(
          tokenRange,
          `Empty tag name. Use tag:<name> to assign a tag, e.g. tag:cache.`,
          vscode.DiagnosticSeverity.Error,
        ),
      );
    }
    return;
  }

  if (allowedOptions.has(token)) {
    if (seenOptions.has(token)) {
      diagnostics.push(
        new vscode.Diagnostic(
          tokenRange,
          `Duplicate option "${token}" in encore:${directiveName} directive.`,
          vscode.DiagnosticSeverity.Warning,
        ),
      );
    }
    seenOptions.add(token);
    return;
  }

  const allKnown = new Set([...allowedOptions, ...allowedFields]);
  const suggestion = findClosestMatch(token, allKnown);
  const suggestionText = suggestion ? ` Did you mean "${suggestion}"?` : "";

  diagnostics.push(
    new vscode.Diagnostic(
      tokenRange,
      `Unknown option "${token}" for encore:${directiveName}.${suggestionText} Valid options: ${[...allowedOptions].join(", ")}.`,
      vscode.DiagnosticSeverity.Error,
    ),
  );
}

function validateFieldToken(
  token: string,
  equalsIndex: number,
  tokenStart: number,
  lineIndex: number,
  directiveName: string,
  allowedFields: Set<string>,
  seenFields: Set<string>,
  diagnostics: vscode.Diagnostic[],
): void {
  const fieldName = token.substring(0, equalsIndex);
  const fieldValue = token.substring(equalsIndex + 1);
  const fieldNameRange = new vscode.Range(
    lineIndex,
    tokenStart,
    lineIndex,
    tokenStart + fieldName.length,
  );

  if (!allowedFields.has(fieldName)) {
    diagnostics.push(
      new vscode.Diagnostic(
        fieldNameRange,
        `Unknown field "${fieldName}" for encore:${directiveName}. Valid fields: ${[...allowedFields].join(", ")}.`,
        vscode.DiagnosticSeverity.Error,
      ),
    );
    return;
  }

  if (seenFields.has(fieldName)) {
    diagnostics.push(
      new vscode.Diagnostic(
        fieldNameRange,
        `Duplicate field "${fieldName}" in encore:${directiveName} directive.`,
        vscode.DiagnosticSeverity.Warning,
      ),
    );
  }
  seenFields.add(fieldName);

  if (fieldName === "method" && fieldValue.length > 0) {
    validateMethodValue(
      fieldValue,
      tokenStart + equalsIndex + 1,
      lineIndex,
      diagnostics,
    );
  }

  if (fieldName === "target" && fieldValue.length > 0) {
    validateTargetValue(
      fieldValue,
      tokenStart + equalsIndex + 1,
      lineIndex,
      diagnostics,
    );
  }
}

function validateMethodValue(
  value: string,
  valueStart: number,
  lineIndex: number,
  diagnostics: vscode.Diagnostic[],
): void {
  const methods = value.split(",");
  let offset = valueStart;

  for (const method of methods) {
    if (method.length > 0 && !HTTP_METHODS.has(method)) {
      diagnostics.push(
        new vscode.Diagnostic(
          new vscode.Range(
            lineIndex,
            offset,
            lineIndex,
            offset + method.length,
          ),
          `Unknown HTTP method "${method}". Valid methods: ${[...HTTP_METHODS].filter((m) => m !== "*").join(", ")}.`,
          vscode.DiagnosticSeverity.Error,
        ),
      );
    }
    offset += method.length + 1;
  }
}

function validateTargetValue(
  value: string,
  valueStart: number,
  lineIndex: number,
  diagnostics: vscode.Diagnostic[],
): void {
  const parts = value.split(",");
  let offset = valueStart;

  for (const part of parts) {
    if (part.length > 0 && part !== "all" && !part.startsWith(TAG_PREFIX)) {
      diagnostics.push(
        new vscode.Diagnostic(
          new vscode.Range(
            lineIndex,
            offset,
            lineIndex,
            offset + part.length,
          ),
          `Invalid target value "${part}". Use "all" or "tag:<name>", e.g. target=tag:cache.`,
          vscode.DiagnosticSeverity.Error,
        ),
      );
    } else if (part === TAG_PREFIX || part === "tag") {
      diagnostics.push(
        new vscode.Diagnostic(
          new vscode.Range(
            lineIndex,
            offset,
            lineIndex,
            offset + part.length,
          ),
          `Empty tag name in target. Use tag:<name>, e.g. target=tag:cache.`,
          vscode.DiagnosticSeverity.Error,
        ),
      );
    }
    offset += part.length + 1;
  }
}

function findClosestMatch(
  input: string,
  candidates: Set<string>,
): string | null {
  const lower = input.toLowerCase();
  for (const candidate of candidates) {
    if (candidate.startsWith(lower) || lower.startsWith(candidate)) {
      return candidate;
    }
  }
  return null;
}

function validateDocument(
  document: vscode.TextDocument,
  diagnosticCollection: vscode.DiagnosticCollection,
): void {
  if (document.languageId !== "go") {
    return;
  }

  const diagnostics: vscode.Diagnostic[] = [];

  for (let i = 0; i < document.lineCount; i++) {
    const line = document.lineAt(i).text;
    if (line.includes("//encore:")) {
      validateDirectiveLine(line, i, diagnostics);
    }
  }

  diagnosticCollection.set(document.uri, diagnostics);
}

/**
 * Runs full validation but on the line being edited only removes
 * diagnostics that no longer apply (fixes are reflected immediately)
 * without adding new diagnostics (avoids nagging while typing).
 */
function validateDocumentWhileEditing(
  document: vscode.TextDocument,
  diagnosticCollection: vscode.DiagnosticCollection,
  editingLine: number,
): void {
  if (document.languageId !== "go") {
    return;
  }

  const freshDiagnostics = computeDiagnostics(document);
  const existingDiagnostics = diagnosticCollection.get(document.uri) ?? [];

  const existingOnEditingLine = existingDiagnostics.filter(
    (d) => d.range.start.line === editingLine,
  );
  const freshOnEditingLine = freshDiagnostics.filter(
    (d) => d.range.start.line === editingLine,
  );

  const survivingOnEditingLine = existingOnEditingLine.filter((existing) =>
    freshOnEditingLine.some(
      (fresh) => fresh.message === existing.message,
    ),
  );

  const freshOtherLines = freshDiagnostics.filter(
    (d) => d.range.start.line !== editingLine,
  );

  diagnosticCollection.set(document.uri, [
    ...freshOtherLines,
    ...survivingOnEditingLine,
  ]);
}

function computeDiagnostics(document: vscode.TextDocument): vscode.Diagnostic[] {
  const diagnostics: vscode.Diagnostic[] = [];

  for (let i = 0; i < document.lineCount; i++) {
    const line = document.lineAt(i).text;
    if (line.includes("//encore:")) {
      validateDirectiveLine(line, i, diagnostics);
    }
  }

  return diagnostics;
}

export function registerEncoreDirectiveDiagnostics(
  context: vscode.ExtensionContext,
): void {
  const diagnosticCollection =
    vscode.languages.createDiagnosticCollection("encore");

  let editingLine: number | null = null;

  const activeEditor = vscode.window.activeTextEditor;
  if (activeEditor) {
    validateDocument(activeEditor.document, diagnosticCollection);
  }

  context.subscriptions.push(
    diagnosticCollection,
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      editingLine = null;
      if (editor) {
        validateDocument(editor.document, diagnosticCollection);
      }
    }),
    vscode.workspace.onDidChangeTextDocument(
      debounce((event: vscode.TextDocumentChangeEvent) => {
        const editor = vscode.window.activeTextEditor;
        if (editor && event.document === editor.document) {
          editingLine = editor.selection.active.line;
          validateDocumentWhileEditing(event.document, diagnosticCollection, editingLine);
        }
      }, 150),
    ),
    vscode.window.onDidChangeTextEditorSelection((event) => {
      if (editingLine !== null && event.selections[0].active.line !== editingLine) {
        editingLine = null;
        validateDocument(event.textEditor.document, diagnosticCollection);
      }
    }),
    vscode.workspace.onDidCloseTextDocument((document) => {
      diagnosticCollection.delete(document.uri);
    }),
  );
}
