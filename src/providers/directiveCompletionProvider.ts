import * as vscode from "vscode";

import {
  ACCESS_MODIFIERS,
  DIRECTIVES_WITH_TAGS,
  FIELD_NAMES,
  HTTP_METHODS,
  KNOWN_DIRECTIVES,
  MODIFIER_KEYWORDS,
  TAG_PREFIX,
  TARGET_VALUES,
} from "../encore/directives";
import {
  ACCESS_MODIFIER_DOCS,
  DIRECTIVE_DOCS,
  FIELD_DOCS,
  MODIFIER_DOCS,
  TAG_DOCS,
  TARGET_VALUE_DOCS,
} from "../encore/documentation";
import { collectWorkspaceTags } from "../utils/tagScanner";

const DIRECTIVE_PREFIX_RE = /\/\/enc(ore)?:?(\w*)$/;
const FIELD_VALUE_RE = /\/\/encore:(\w+)\s+.*\b(\w+)=([^=\s]*)$/;
const TAG_CONTEXT_RE = /\/\/encore:(\w+)\s+.*tag:(\w*)$/;

export class EncoreDirectiveCompletionProvider
  implements vscode.CompletionItemProvider
{
  async provideCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
  ): Promise<vscode.CompletionItem[] | undefined> {
    const lineText = document.lineAt(position.line).text;
    const textUpToCursor = lineText.substring(0, position.character);

    const tagNameCompletions = await this.completeTagName(textUpToCursor, position);
    if (tagNameCompletions) {
      return tagNameCompletions;
    }

    const fieldValueCompletions = this.completeFieldValue(textUpToCursor, position);
    if (fieldValueCompletions) {
      return fieldValueCompletions;
    }

    const directivePrefixMatch = textUpToCursor.match(DIRECTIVE_PREFIX_RE);
    if (directivePrefixMatch) {
      return this.completeDirectivePrefix(directivePrefixMatch, position);
    }

    const directiveTokenCompletions = this.completeDirectiveTokens(textUpToCursor, position);
    if (directiveTokenCompletions) {
      return directiveTokenCompletions;
    }

    return undefined;
  }

  /**
   * Completes the directive prefix: //enc → //encore:api, //encore: → api, service, etc.
   */
  private completeDirectivePrefix(
    match: RegExpMatchArray,
    position: vscode.Position,
  ): vscode.CompletionItem[] {
    const hasFullPrefix = match[1] !== undefined;
    const hasColon = match[0].includes(":");
    const partialDirective = match[2] || "";

    if (hasFullPrefix && hasColon) {
      return this.buildDirectiveNameCompletions(partialDirective, position);
    }

    return this.buildFullDirectiveCompletions(match[0], position);
  }

  private buildDirectiveNameCompletions(
    partial: string,
    position: vscode.Position,
  ): vscode.CompletionItem[] {
    const items: vscode.CompletionItem[] = [];

    for (const directive of KNOWN_DIRECTIVES) {
      if (partial.length > 0 && !directive.startsWith(partial)) {
        continue;
      }

      const item = new vscode.CompletionItem(
        directive,
        vscode.CompletionItemKind.Keyword,
      );
      item.detail = `encore:${directive}`;
      item.insertText = directive.substring(partial.length);
      item.sortText = `0_${directive}`;

      item.documentation = markdownString(DIRECTIVE_DOCS[directive]);

      items.push(item);
    }

    return items;
  }

  private buildFullDirectiveCompletions(
    typedPrefix: string,
    position: vscode.Position,
  ): vscode.CompletionItem[] {
    const items: vscode.CompletionItem[] = [];
    const prefixStart = position.character - typedPrefix.length;

    for (const directive of KNOWN_DIRECTIVES) {
      const fullText = `//encore:${directive}`;

      const item = new vscode.CompletionItem(
        fullText,
        vscode.CompletionItemKind.Keyword,
      );
      item.detail = `Encore directive`;
      item.insertText = fullText;
      item.range = new vscode.Range(
        position.line,
        prefixStart,
        position.line,
        position.character,
      );
      item.sortText = `0_${directive}`;

      item.documentation = markdownString(DIRECTIVE_DOCS[directive]);

      items.push(item);
    }

    return items;
  }

  /**
   * Completes options and field names after a directive.
   * Access modifiers (public/private/auth) are only suggested as the first token.
   * Modifier keywords, fields, and tags are suggested after the access modifier.
   */
  private completeDirectiveTokens(
    textUpToCursor: string,
    position: vscode.Position,
  ): vscode.CompletionItem[] | undefined {
    const directiveMatch = textUpToCursor.match(
      /\/\/encore:(\w+)\s+(.*?)(\w*)$/,
    );
    if (!directiveMatch) {
      return undefined;
    }

    const directiveName = directiveMatch[1];
    if (!KNOWN_DIRECTIVES.has(directiveName)) {
      return undefined;
    }

    const precedingTokensText = directiveMatch[2];
    const partialToken = directiveMatch[3];
    const usedTokens = this.parseUsedTokens(precedingTokensText);
    const accessModifiers = ACCESS_MODIFIERS[directiveName] ?? new Set();
    const modifierKeywords = MODIFIER_KEYWORDS[directiveName] ?? new Set();
    const allowedFields = FIELD_NAMES[directiveName] ?? new Set();
    const isFirstToken = usedTokens.tokenCount === 0;
    const items: vscode.CompletionItem[] = [];

    if (isFirstToken && accessModifiers.size > 0) {
      for (const modifier of accessModifiers) {
        if (partialToken.length > 0 && !modifier.startsWith(partialToken)) {
          continue;
        }

        const item = new vscode.CompletionItem(
          modifier,
          vscode.CompletionItemKind.EnumMember,
        );
        item.detail = `encore:${directiveName} access modifier`;
        item.sortText = `0_${modifier}`;
        item.documentation = markdownString(ACCESS_MODIFIER_DOCS[modifier]);
        items.push(item);
      }
      return items.length > 0 ? items : undefined;
    }

    for (const keyword of modifierKeywords) {
      if (usedTokens.options.has(keyword)) {
        continue;
      }
      if (partialToken.length > 0 && !keyword.startsWith(partialToken)) {
        continue;
      }

      const item = new vscode.CompletionItem(
        keyword,
        vscode.CompletionItemKind.EnumMember,
      );
      item.detail = `encore:${directiveName} modifier`;
      item.sortText = `1_${keyword}`;
      item.documentation = markdownString(MODIFIER_DOCS[keyword]);
      items.push(item);
    }

    for (const field of allowedFields) {
      if (usedTokens.fields.has(field)) {
        continue;
      }
      if (partialToken.length > 0 && !field.startsWith(partialToken)) {
        continue;
      }

      const item = new vscode.CompletionItem(
        `${field}=`,
        vscode.CompletionItemKind.Field,
      );
      item.detail = `encore:${directiveName} field`;
      item.sortText = `2_${field}`;
      item.documentation = markdownString(FIELD_DOCS[field]);
      items.push(item);
    }

    if (DIRECTIVES_WITH_TAGS.has(directiveName)) {
      const tagLabel = "tag:";
      if (partialToken.length === 0 || tagLabel.startsWith(partialToken)) {
        const item = new vscode.CompletionItem(
          tagLabel,
          vscode.CompletionItemKind.Property,
        );
        item.detail = "API tag for middleware targeting";
        item.documentation = markdownString(TAG_DOCS);
        item.sortText = `4_tag`;
        items.push(item);
      }
    }

    return items.length > 0 ? items : undefined;
  }

  /**
   * Completes tag names after tag: in //encore:api and after target=tag: in //encore:middleware.
   * Scans workspace Go files for existing tag names.
   * Returns [] (empty array) when in tag context but no tags found, to suppress fallback completions.
   */
  private async completeTagName(
    textUpToCursor: string,
    _position: vscode.Position,
  ): Promise<vscode.CompletionItem[] | undefined> {
    const tagMatch = textUpToCursor.match(TAG_CONTEXT_RE);
    if (!tagMatch) {
      return undefined;
    }

    const directiveName = tagMatch[1];
    if (!KNOWN_DIRECTIVES.has(directiveName)) {
      return undefined;
    }

    const partialName = tagMatch[2] || "";
    const workspaceTags = await collectWorkspaceTags();
    const items: vscode.CompletionItem[] = [];

    for (const tagName of workspaceTags) {
      if (partialName.length > 0 && !tagName.startsWith(partialName)) {
        continue;
      }

      const item = new vscode.CompletionItem(
        tagName,
        vscode.CompletionItemKind.Reference,
      );
      item.detail = "tag used in workspace";
      item.insertText = tagName.substring(partialName.length);
      item.sortText = `0_${tagName}`;
      items.push(item);
    }

    return items;
  }

  /**
   * Completes field values, e.g. //encore:api method=G → GET,
   * and comma-separated methods like method=GET,P → POST, PUT, PATCH
   */
  private completeFieldValue(
    textUpToCursor: string,
    position: vscode.Position,
  ): vscode.CompletionItem[] | undefined {
    const fieldValueMatch = textUpToCursor.match(FIELD_VALUE_RE);
    if (!fieldValueMatch) {
      return undefined;
    }

    const directiveName = fieldValueMatch[1];
    const fieldName = fieldValueMatch[2];
    const fieldValue = fieldValueMatch[3];

    if (!KNOWN_DIRECTIVES.has(directiveName)) {
      return undefined;
    }
    const allowedFields = FIELD_NAMES[directiveName];
    if (!allowedFields || !allowedFields.has(fieldName)) {
      return undefined;
    }

    if (fieldName === "method") {
      return this.completeMethodValue(fieldValue, position);
    }

    if (fieldName === "target") {
      return this.completeTargetValue(fieldValue, position);
    }

    return [];
  }

  private completeMethodValue(
    fieldValue: string,
    position: vscode.Position,
  ): vscode.CompletionItem[] {
    const parts = fieldValue.split(",");
    const currentPart = parts[parts.length - 1];
    const alreadyUsed = new Set(parts.slice(0, -1));
    const items: vscode.CompletionItem[] = [];

    for (const method of HTTP_METHODS) {
      if (method === "*") {
        continue;
      }
      if (alreadyUsed.has(method)) {
        continue;
      }
      if (currentPart.length > 0 && !method.startsWith(currentPart.toUpperCase())) {
        continue;
      }

      const item = new vscode.CompletionItem(
        method,
        vscode.CompletionItemKind.Value,
      );
      item.detail = "HTTP method";
      item.insertText = method.substring(currentPart.length);
      item.sortText = `0_${method}`;
      items.push(item);
    }

    return items;
  }

  private completeTargetValue(
    fieldValue: string,
    position: vscode.Position,
  ): vscode.CompletionItem[] {
    const parts = fieldValue.split(",");
    const currentPart = parts[parts.length - 1];
    const items: vscode.CompletionItem[] = [];

    for (const value of TARGET_VALUES) {
      if (currentPart.length > 0 && !value.startsWith(currentPart)) {
        continue;
      }

      const item = new vscode.CompletionItem(
        value,
        vscode.CompletionItemKind.Value,
      );
      item.detail = "Target all API endpoints";
      item.insertText = value.substring(currentPart.length);
      item.sortText = `0_${value}`;
      item.documentation = markdownString(TARGET_VALUE_DOCS[value]);
      items.push(item);
    }

    const tagLabel = `${TAG_PREFIX}`;
    if (currentPart.length === 0 || tagLabel.startsWith(currentPart)) {
      const item = new vscode.CompletionItem(
        tagLabel,
        vscode.CompletionItemKind.Property,
      );
      item.detail = "Target APIs by tag";
      item.documentation = markdownString(TARGET_VALUE_DOCS["tag:"]);
      item.insertText = tagLabel.substring(currentPart.length);
      item.sortText = `1_tag`;
      items.push(item);
    }

    return items;
  }

  private parseUsedTokens(text: string): ParsedTokens {
    const tokens = text.match(/\S+/g) ?? [];
    const result: ParsedTokens = {
      options: new Set(),
      fields: new Set(),
      tokenCount: tokens.length,
    };

    for (const token of tokens) {
      const equalsIndex = token.indexOf("=");
      if (equalsIndex !== -1) {
        result.fields.add(token.substring(0, equalsIndex));
      } else {
        result.options.add(token);
      }
    }

    return result;
  }
}

interface ParsedTokens {
  options: Set<string>;
  fields: Set<string>;
  tokenCount: number;
}

function markdownString(content: string | undefined): vscode.MarkdownString | undefined {
  if (!content) {
    return undefined;
  }
  const md = new vscode.MarkdownString(content);
  md.supportHtml = true;
  return md;
}
