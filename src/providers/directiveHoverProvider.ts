import * as vscode from "vscode";

import {
  ACCESS_MODIFIERS,
  DIRECTIVE_RE,
  DIRECTIVES_WITH_TAGS,
  FIELD_NAMES,
  KNOWN_DIRECTIVES,
  TAG_PREFIX,
  getAllOptions,
} from "../encore/directives";
import {
  ACCESS_MODIFIER_DOCS,
  DIRECTIVE_DOCS,
  FIELD_DOCS,
  MODIFIER_DOCS,
  TAG_DOCS,
  TARGET_VALUE_DOCS,
} from "../encore/documentation";

export class EncoreDirectiveHoverProvider implements vscode.HoverProvider {
  provideHover(
    document: vscode.TextDocument,
    position: vscode.Position,
  ): vscode.Hover | undefined {
    const line = document.lineAt(position.line).text;
    const directiveMatch = line.match(DIRECTIVE_RE);
    if (!directiveMatch || directiveMatch.index === undefined) {
      return undefined;
    }

    const directiveName = directiveMatch[1];
    const directiveStart = directiveMatch.index;
    const directiveEnd = directiveStart + directiveMatch[0].length;

    if (position.character >= directiveStart && position.character < directiveEnd) {
      return this.hoverDirectiveName(directiveName, position.line, directiveStart, directiveEnd);
    }

    const tokenAtCursor = this.getTokenAtPosition(line, position.character, directiveEnd);
    if (!tokenAtCursor) {
      return undefined;
    }

    return this.hoverToken(tokenAtCursor.text, tokenAtCursor.start, tokenAtCursor.end, position.line, directiveName);
  }

  private hoverDirectiveName(
    directiveName: string,
    lineIndex: number,
    start: number,
    end: number,
  ): vscode.Hover | undefined {
    const doc = DIRECTIVE_DOCS[directiveName];
    if (!doc) {
      return undefined;
    }

    const range = new vscode.Range(lineIndex, start, lineIndex, end);
    return new vscode.Hover(new vscode.MarkdownString(doc), range);
  }

  private hoverToken(
    token: string,
    tokenStart: number,
    tokenEnd: number,
    lineIndex: number,
    directiveName: string,
  ): vscode.Hover | undefined {
    const range = new vscode.Range(lineIndex, tokenStart, lineIndex, tokenEnd);

    const accessModifiers = ACCESS_MODIFIERS[directiveName] ?? new Set();
    if (accessModifiers.has(token)) {
      const doc = ACCESS_MODIFIER_DOCS[token];
      if (doc) {
        return new vscode.Hover(new vscode.MarkdownString(doc), range);
      }
    }

    const allOptions = getAllOptions(directiveName);
    if (allOptions.has(token)) {
      const doc = MODIFIER_DOCS[token];
      if (doc) {
        return new vscode.Hover(new vscode.MarkdownString(doc), range);
      }
    }

    if (token.startsWith(TAG_PREFIX) && DIRECTIVES_WITH_TAGS.has(directiveName)) {
      return new vscode.Hover(new vscode.MarkdownString(TAG_DOCS), range);
    }

    const equalsIndex = token.indexOf("=");
    if (equalsIndex !== -1) {
      const fieldName = token.substring(0, equalsIndex);
      const allowedFields = FIELD_NAMES[directiveName] ?? new Set();
      if (allowedFields.has(fieldName)) {
        const fieldDoc = FIELD_DOCS[fieldName];
        if (fieldDoc) {
          const fieldRange = new vscode.Range(lineIndex, tokenStart, lineIndex, tokenStart + fieldName.length);
          return new vscode.Hover(new vscode.MarkdownString(fieldDoc), fieldRange);
        }
      }

      if (fieldName === "target") {
        const fieldValue = token.substring(equalsIndex + 1);
        const valueStart = tokenStart + equalsIndex + 1;
        const valueAtCursor = this.getValuePartAtPosition(fieldValue, valueStart, tokenStart + token.length, lineIndex);
        if (valueAtCursor) {
          const doc = valueAtCursor.text === "all"
            ? TARGET_VALUE_DOCS["all"]
            : valueAtCursor.text.startsWith(TAG_PREFIX)
              ? TARGET_VALUE_DOCS["tag:"]
              : undefined;
          if (doc) {
            return new vscode.Hover(
              new vscode.MarkdownString(doc),
              new vscode.Range(lineIndex, valueAtCursor.start, lineIndex, valueAtCursor.end),
            );
          }
        }
      }
    }

    return undefined;
  }

  private getTokenAtPosition(
    line: string,
    charPos: number,
    searchStart: number,
  ): { text: string; start: number; end: number } | undefined {
    const rest = line.substring(searchStart);
    const tokenRe = /\S+/g;

    let tokenMatch: RegExpExecArray | null;
    while ((tokenMatch = tokenRe.exec(rest)) !== null) {
      const start = searchStart + tokenMatch.index;
      const end = start + tokenMatch[0].length;
      if (charPos >= start && charPos < end) {
        return { text: tokenMatch[0], start, end };
      }
    }

    return undefined;
  }

  private getValuePartAtPosition(
    fieldValue: string,
    valueStart: number,
    _valueEnd: number,
    _lineIndex: number,
  ): { text: string; start: number; end: number } | undefined {
    const parts = fieldValue.split(",");
    let offset = valueStart;

    for (const part of parts) {
      const partEnd = offset + part.length;
      if (part.length > 0) {
        return { text: part, start: offset, end: partEnd };
      }
      offset = partEnd + 1;
    }

    return undefined;
  }
}
