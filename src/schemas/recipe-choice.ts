// The recipe choice out doc (ADR 0232): the question of a step that chooses the batch's recipe,
// whose options are among the Brewery's recipes it may offer. Built per step from those names, as
// a Taster's is from its lenses (ADR 0220).

import { OutDocFrontmatter as Contract, type OutDocFrontmatter } from './out-doc.ts';
import type { z } from './zod.ts';

/** The name of a recipe choice's out doc schema (`output.schema`, ADR 0232). */
export const RECIPE_CHOICE = 'recipeChoice';

/**
 * The out doc of a step that chooses among `choices` (ADR 0232): `needs_input` with one question
 * whose options are among them, or `blocked` or `failed` as for any brewer; never `done`, since
 * only a person's answer chooses.
 */
export const recipeChoiceOutDocOf = (choices: readonly string[]): z.ZodType<OutDocFrontmatter> =>
  Contract.superRefine((doc, ctx) => {
    if (doc.status === 'done') {
      ctx.addIssue({
        code: 'custom',
        message: 'Must be needs_input: a person chooses the recipe by answering its question',
        path: ['status'],
      });
      return;
    }
    if (doc.status !== 'needs_input') return;
    if (doc.questions.length !== 1) {
      ctx.addIssue({
        code: 'custom',
        message: 'Must ask exactly one question: which recipe brews the order',
        path: ['questions'],
      });
    }
    for (const [at, { options }] of doc.questions.entries()) {
      for (const [n, option] of options.entries()) {
        if (choices.includes(option)) continue;
        ctx.addIssue({
          code: 'custom',
          message: `Must be one of the Brewery's recipes to offer, ${choices.join(', ')}: it has no ${option}`,
          path: ['questions', at, 'options', n],
        });
      }
    }
  });
