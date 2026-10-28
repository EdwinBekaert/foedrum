// The recipe choice out doc (ADR 0232): the question of a step that chooses the batch's recipe,
// whose options are among the Brewery's recipes it may offer.

import type { OutDocFrontmatter } from './out-doc.ts';
import type { z } from './zod.ts';

/** The name of a recipe choice's out doc schema (`output.schema`, ADR 0232). */
export const RECIPE_CHOICE = 'recipeChoice';

/**
 * The out doc of a step that chooses among `choices` (ADR 0232): `needs_input` with one question
 * whose options are among them; never `done`.
 */
export const recipeChoiceOutDocOf = (_choices: readonly string[]): z.ZodType<OutDocFrontmatter> => {
  throw new Error('not implemented');
};
