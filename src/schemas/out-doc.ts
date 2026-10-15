// Out-doc frontmatter (brewers-and-recipes §2, ADR 0005). Stub: not implemented yet.

import { z } from './zod.ts';

export const OutDocFrontmatter = z.never();
export type OutDocFrontmatter = z.infer<typeof OutDocFrontmatter>;

export const outDocFrontmatter = (_fields: z.ZodRawShape) => z.never();

export type OutDocResult<T> =
  | { valid: true; frontmatter: T; body: string }
  | { valid: false; reason: string };

export function readOutDoc<T>(_text: string, _schema: z.ZodType<T>): OutDocResult<T> {
  throw new Error('not implemented');
}
