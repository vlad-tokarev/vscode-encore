export const ENCORE_GEN_FILENAME = "encore.gen.go";

export const GENERATED_FUNC_RE = /^func\s+(\w+)\s*\(/;
export const INTERFACE_METHOD_RE = /^\s+(\w+)\s*\(/;
export const STRUCT_METHOD_RE = /^func\s+\(\s*\w+\s+\*?\w+\s*\)\s+(\w+)\s*\(/;

export const GO_LANGUAGE_SELECTOR: { language: string; scheme: string } = {
  language: "go",
  scheme: "file",
};
