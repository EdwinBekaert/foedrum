// Out-doc frontmatter: how a brewer reports its outcome (brewers-and-recipes §2, ADR 0005).

import { type DocResult, readDoc } from './read.ts';
import { NonEmpty, Question } from './step-outcome.ts';
import { z } from './zod.ts';

export const BlockerKind = z.enum(['findings', 'environment', 'divergence']);
export type BlockerKind = z.infer<typeof BlockerKind>;

const shared = {
  summary: NonEmpty.regex(/^[^\r\n]*$/, 'Must be one line'),
  assumptions: z.array(NonEmpty).default([]),
};

// `questions` only with needs_input and `blockerKind` only with blocked: strict objects reject them elsewhere.
const variants = [
  z.strictObject({ status: z.literal('done'), ...shared }),
  z.strictObject({
    status: z.literal('needs_input'),
    ...shared,
    questions: z.array(Question).min(1),
  }),
  z.strictObject({ status: z.literal('blocked'), ...shared, blockerKind: BlockerKind }),
  z.strictObject({ status: z.literal('failed'), ...shared }),
] as const;

const contractFields = new Set(variants.flatMap((variant) => Object.keys(variant.shape)));

/** The out-doc frontmatter with a brewer's own fields (for example a review verdict) added to every status. */
export const outDocFrontmatter = <Fields extends z.ZodRawShape>(fields: Fields) => {
  const replaced = Object.keys(fields).filter((key) => contractFields.has(key));
  if (replaced.length > 0) {
    throw new Error(`Brewer-specific fields cannot replace the out-doc contract: ${replaced}`);
  }
  return z.discriminatedUnion('status', [
    variants[0].extend(fields),
    variants[1].extend(fields),
    variants[2].extend(fields),
    variants[3].extend(fields),
  ]);
};

export const OutDocFrontmatter = z.discriminatedUnion('status', [...variants]);
export type OutDocFrontmatter = z.infer<typeof OutDocFrontmatter>;

/** Reads an out doc; a syntax error or a frontmatter that breaks `schema` makes it invalid, with the reason. */
export function readOutDoc<T>(text: string, schema: z.ZodType<T>): DocResult<T> {
  return readDoc(text, schema);
}

/**
 * The assumptions of an out doc that succeeded, beside whatever else it holds (a brewer's own
 * fields): what the status comment shows (ADR 0072).
 */
export const OutDocAssumptions = z.object({ assumptions: z.array(z.string()) });
