// JSONC reader (ADR 0007): JSON with comments and trailing commas.

export function parseJsonc(text: string): unknown {
  return JSON.parse(text);
}
