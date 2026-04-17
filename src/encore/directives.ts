export const DIRECTIVE_RE = /\/\/encore:(\w+)/;

export const KNOWN_DIRECTIVES = new Set([
  "api",
  "service",
  "authhandler",
  "middleware",
]);

export const ACCESS_MODIFIERS: Record<string, Set<string>> = {
  api: new Set(["public", "private", "auth"]),
  middleware: new Set(),
  authhandler: new Set(),
  service: new Set(),
};

export const MODIFIER_KEYWORDS: Record<string, Set<string>> = {
  api: new Set(["raw", "sensitive"]),
  middleware: new Set(["global"]),
  authhandler: new Set(),
  service: new Set(),
};

/** All option keywords (access modifiers + modifier keywords) for validation purposes. */
export function getAllOptions(directive: string): Set<string> {
  const access = ACCESS_MODIFIERS[directive] ?? new Set();
  const modifiers = MODIFIER_KEYWORDS[directive] ?? new Set();
  return new Set([...access, ...modifiers]);
}

export const FIELD_NAMES: Record<string, Set<string>> = {
  api: new Set(["path", "method"]),
  middleware: new Set(["target"]),
  authhandler: new Set(),
  service: new Set(),
};

export const TAG_PREFIX = "tag:";

export const DIRECTIVES_WITH_TAGS = new Set(["api"]);

export const TARGET_VALUES = ["all"];

export const HTTP_METHODS = new Set([
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "HEAD",
  "OPTIONS",
  "TRACE",
  "CONNECT",
  "*",
]);
