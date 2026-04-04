import * as vscode from "vscode";

import {
  DIRECTIVE_RE,
  FIELD_NAMES,
  HTTP_METHODS,
  KNOWN_DIRECTIVES,
  TAG_PREFIX,
  getAllOptions,
} from "../encore/directives";
import { debounce } from "../utils/debounce";

const directivePrefixDecorationType = vscode.window.createTextEditorDecorationType({
  color: new vscode.ThemeColor("editorCodeLens.foreground"),
});

const directiveNameDecorationType = vscode.window.createTextEditorDecorationType({
  color: new vscode.ThemeColor("editorCodeLens.foreground"),
  fontWeight: "bold",
});

const optionDecorationType = vscode.window.createTextEditorDecorationType({
  color: new vscode.ThemeColor("symbolIcon.keywordForeground"),
});

const fieldNameDecorationType = vscode.window.createTextEditorDecorationType({
  color: new vscode.ThemeColor("symbolIcon.fieldForeground"),
});

const pathParamDecorationType = vscode.window.createTextEditorDecorationType({
  color: new vscode.ThemeColor("symbolIcon.variableForeground"),
  fontStyle: "italic",
});

const tagDecorationType = vscode.window.createTextEditorDecorationType({
  color: new vscode.ThemeColor("symbolIcon.enumeratorMemberForeground"),
  fontStyle: "italic",
});

function parseDirectiveLine(
  line: string,
  lineIndex: number,
): {
  prefixRange: vscode.Range;
  nameRange: vscode.Range;
  directiveName: string;
  restStart: number;
  restText: string;
} | null {
  const match = line.match(DIRECTIVE_RE);
  if (!match || match.index === undefined) {
    return null;
  }

  const directiveName = match[1];
  const directiveStart = match.index;
  const colonEnd = directiveStart + "//encore:".length;
  const directiveEnd = directiveStart + match[0].length;

  return {
    prefixRange: new vscode.Range(
      lineIndex,
      directiveStart,
      lineIndex,
      colonEnd,
    ),
    nameRange: new vscode.Range(
      lineIndex,
      colonEnd,
      lineIndex,
      directiveEnd,
    ),
    directiveName,
    restStart: directiveEnd,
    restText: line.substring(directiveEnd),
  };
}

function collectTokenDecorations(
  directiveName: string,
  restText: string,
  restStart: number,
  lineIndex: number,
): {
  options: vscode.DecorationOptions[];
  fields: vscode.DecorationOptions[];
  pathParams: vscode.DecorationOptions[];
  tags: vscode.DecorationOptions[];
} {
  const options: vscode.DecorationOptions[] = [];
  const fields: vscode.DecorationOptions[] = [];
  const pathParams: vscode.DecorationOptions[] = [];
  const tags: vscode.DecorationOptions[] = [];

  const allowedOptions = getAllOptions(directiveName);
  const allowedFields = FIELD_NAMES[directiveName];
  if (!allowedOptions || !allowedFields) {
    return { options, fields, pathParams, tags };
  }

  const tokenRe = /\S+/g;
  let tokenMatch: RegExpExecArray | null;

  while ((tokenMatch = tokenRe.exec(restText)) !== null) {
    const token = tokenMatch[0];
    const tokenStart = restStart + tokenMatch.index;
    const tokenEnd = tokenStart + token.length;

    const equalsIndex = token.indexOf("=");

    if (equalsIndex === -1) {
      if (allowedOptions.has(token)) {
        options.push({
          range: new vscode.Range(lineIndex, tokenStart, lineIndex, tokenEnd),
        });
      } else if (token.startsWith(TAG_PREFIX)) {
        tags.push({
          range: new vscode.Range(lineIndex, tokenStart, lineIndex, tokenEnd),
        });
      }

      if (token.startsWith("/")) {
        collectPathParamDecorations(
          token,
          tokenStart,
          lineIndex,
          pathParams,
        );
      }

      if (HTTP_METHODS.has(token) || token.includes(",")) {
        const methodTokens = token.split(",");
        let methodOffset = tokenStart;
        for (const methodToken of methodTokens) {
          if (HTTP_METHODS.has(methodToken)) {
            options.push({
              range: new vscode.Range(
                lineIndex,
                methodOffset,
                lineIndex,
                methodOffset + methodToken.length,
              ),
            });
          }
          methodOffset += methodToken.length + 1;
        }
      }
    } else {
      const fieldName = token.substring(0, equalsIndex);
      const fieldValue = token.substring(equalsIndex + 1);

      if (allowedFields.has(fieldName)) {
        fields.push({
          range: new vscode.Range(
            lineIndex,
            tokenStart,
            lineIndex,
            tokenStart + fieldName.length,
          ),
        });
      }

      if (fieldName === "path") {
        const valueStart = tokenStart + equalsIndex + 1;
        collectPathParamDecorations(
          fieldValue,
          valueStart,
          lineIndex,
          pathParams,
        );
      }

      if (fieldName === "method") {
        const valueStart = tokenStart + equalsIndex + 1;
        const methods = fieldValue.split(",");
        let methodOffset = valueStart;
        for (const method of methods) {
          if (HTTP_METHODS.has(method)) {
            options.push({
              range: new vscode.Range(
                lineIndex,
                methodOffset,
                lineIndex,
                methodOffset + method.length,
              ),
            });
          }
          methodOffset += method.length + 1;
        }
      }
    }
  }

  return { options, fields, pathParams, tags };
}

function collectPathParamDecorations(
  pathText: string,
  pathStart: number,
  lineIndex: number,
  pathParams: vscode.DecorationOptions[],
): void {
  const segments = pathText.split("/");
  let offset = pathStart;

  for (const segment of segments) {
    if (segment.startsWith(":") || segment.startsWith("*")) {
      pathParams.push({
        range: new vscode.Range(
          lineIndex,
          offset,
          lineIndex,
          offset + segment.length,
        ),
      });
    }
    offset += segment.length + 1;
  }
}

export function updateEncoreDirectiveDecorations(
  editor: vscode.TextEditor,
): void {
  if (editor.document.languageId !== "go") {
    return;
  }

  const prefixes: vscode.DecorationOptions[] = [];
  const names: vscode.DecorationOptions[] = [];
  const allOptions: vscode.DecorationOptions[] = [];
  const allFields: vscode.DecorationOptions[] = [];
  const allPathParams: vscode.DecorationOptions[] = [];
  const allTags: vscode.DecorationOptions[] = [];

  for (let i = 0; i < editor.document.lineCount; i++) {
    const line = editor.document.lineAt(i).text;
    const parsed = parseDirectiveLine(line, i);
    if (!parsed) {
      continue;
    }

    if (!KNOWN_DIRECTIVES.has(parsed.directiveName)) {
      continue;
    }

    prefixes.push({ range: parsed.prefixRange });
    names.push({ range: parsed.nameRange });

    const tokens = collectTokenDecorations(
      parsed.directiveName,
      parsed.restText,
      parsed.restStart,
      i,
    );

    allOptions.push(...tokens.options);
    allFields.push(...tokens.fields);
    allPathParams.push(...tokens.pathParams);
    allTags.push(...tokens.tags);
  }

  editor.setDecorations(directivePrefixDecorationType, prefixes);
  editor.setDecorations(directiveNameDecorationType, names);
  editor.setDecorations(optionDecorationType, allOptions);
  editor.setDecorations(fieldNameDecorationType, allFields);
  editor.setDecorations(pathParamDecorationType, allPathParams);
  editor.setDecorations(tagDecorationType, allTags);
}

export function registerEncoreDirectiveDecorations(
  context: vscode.ExtensionContext,
): void {
  const activeEditor = vscode.window.activeTextEditor;
  if (activeEditor) {
    updateEncoreDirectiveDecorations(activeEditor);
  }

  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (editor) {
        updateEncoreDirectiveDecorations(editor);
      }
    }),
    vscode.workspace.onDidChangeTextDocument(
      debounce((event: vscode.TextDocumentChangeEvent) => {
        const activeTextEditor = vscode.window.activeTextEditor;
        if (activeTextEditor && event.document === activeTextEditor.document) {
          updateEncoreDirectiveDecorations(activeTextEditor);
        }
      }, 150),
    ),
    directivePrefixDecorationType,
    directiveNameDecorationType,
    optionDecorationType,
    fieldNameDecorationType,
    pathParamDecorationType,
    tagDecorationType,
  );
}
