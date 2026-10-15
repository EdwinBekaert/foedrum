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
