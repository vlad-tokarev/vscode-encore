export function escapeRegex(source: string): string {
  return source.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function buildMethodRegex(funcName: string): RegExp {
  return new RegExp(
    `^func\\s+\\(\\s*\\w+\\s+\\*?\\w+\\s*\\)\\s+${escapeRegex(funcName)}\\s*\\(`,
  );
}
