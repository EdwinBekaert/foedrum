// Reading JSONC files and Markdown files with frontmatter against a schema (ADR 0020).

import { parseFrontmatter } from '../formats/frontmatter.ts';
import { parseJsonc } from '../formats/jsonc.ts';
import { z } from './zod.ts';

export type ReadResult<T> = { valid: true; value: T } | { valid: false; reason: string };

export type DocResult<T> =
  | { valid: true; frontmatter: T; body: string }
  | { valid: false; reason: string };

/** Reads a JSONC file such as foedrum.jsonc; a syntax error or a broken schema gives the reason. */
export function readJsonc<T>(text: string, schema: z.ZodType<T>): ReadResult<T> {
  const parsed = syntax(() => parseJsonc(text));
  if (!parsed.valid) return parsed;
  const result = schema.safeParse(parsed.value);
  return result.success
    ? { valid: true, value: result.data }
    : { valid: false, reason: z.prettifyError(result.error) };
}

/** Reads a Markdown file with frontmatter, such as a brewer or a house-yeast rule. */
export function readDoc<T>(text: string, schema: z.ZodType<T>): DocResult<T> {
  const parsed = syntax(() => parseFrontmatter(text));
  if (!parsed.valid) return parsed;
  const result = schema.safeParse(parsed.value.data);
  return result.success
    ? { valid: true, frontmatter: result.data, body: parsed.value.body }
    : { valid: false, reason: z.prettifyError(result.error) };
}

function syntax<T>(parse: () => T): ReadResult<T> {
  try {
    return { valid: true, value: parse() };
  } catch (error) {
    // ParseError, or JSON.parse's own SyntaxError when the reader cannot locate the error.
    if (error instanceof SyntaxError) return { valid: false, reason: error.message };
    throw error;
  }
}
