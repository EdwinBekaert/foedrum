// Reading JSONC files and Markdown files with frontmatter against a schema (ADR 0020).

import type { z } from './zod.ts';

export type ReadResult<T> = { valid: true; value: T } | { valid: false; reason: string };

export type DocResult<T> =
  | { valid: true; frontmatter: T; body: string }
  | { valid: false; reason: string };

export function readJsonc<T>(_text: string, _schema: z.ZodType<T>): ReadResult<T> {
  throw new Error('not implemented');
}

export function readDoc<T>(_text: string, _schema: z.ZodType<T>): DocResult<T> {
  throw new Error('not implemented');
}
