// House-yeast rule frontmatter: one learned rule per file (ADR 0018).

import { PathSafeId } from './ids.ts';
import { NonEmpty } from './step-outcome.ts';
import { z } from './zod.ts';

export const HouseYeastRule = z.strictObject({
  id: PathSafeId,
  // The repository is not part of the scope: it follows from where the rule is stored.
  scope: z.strictObject({
    globs: z.array(NonEmpty).min(1).optional(),
    language: z
      .string()
      .regex(/^[a-z0-9][a-z0-9+#.-]*$/, 'Must be a lower-case language name')
      .optional(),
    lens: PathSafeId.optional(),
  }),
  kind: z.enum(['structural', 'semantic']),
  source: NonEmpty.describe('The review or comment that produced the rule'),
  created: z.iso.date(),
  status: z.enum(['active', 'retired']),
});
export type HouseYeastRule = z.infer<typeof HouseYeastRule>;

// A lesson seen once in a review of Foedrum's own pull requests, one line of the main checkout's
// .foedrum/house-yeast-candidates.jsonl until the state branch carries candidates (ADR 0122).
export const HouseYeastCandidate = z.strictObject({
  lesson: PathSafeId.describe('The id of the rule the lesson would become'),
  review: NonEmpty.describe('The pull request reviewed, or the branch of a local run'),
  source: NonEmpty.describe('The finding or comment that taught the lesson'),
  seen: z.iso.date(),
  kind: HouseYeastRule.shape.kind,
  scope: HouseYeastRule.shape.scope,
  rule: NonEmpty.describe('The rule in one or two sentences'),
});
export type HouseYeastCandidate = z.infer<typeof HouseYeastCandidate>;
