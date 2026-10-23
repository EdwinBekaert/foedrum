// models.jsonc: model aliases and per-brewer overrides (brewers-and-recipes §5).

import { PathSafeId } from './ids.ts';
import { z } from './zod.ts';

/** A name brewers use for a model, so evaluations can swap the model behind it. */
export const ModelAlias = z
  .string()
  .regex(
    /^[a-z][a-z0-9-]{0,63}$/,
    'Must be lower-case letters, digits and "-", starting with a letter',
  );

// Passed to `claude --model`, which on Windows runs through a shell: no spaces, quotes or
// operators, and no leading dash that could read as an option.
export const ModelId = z
  .string()
  .regex(
    /^[a-z0-9][a-z0-9._:-]{0,127}(?:\[1m\])?$/,
    'Must be a model id or family such as "claude-sonnet-5-5" or "sonnet"',
  );

/**
 * The fields of a models.jsonc, without the check that its `brewers` name an alias of its own
 * `models`: a Brewery's file may name an alias of Foedrum's defaults, so serve checks it on the
 * merged models (ADR 0153).
 */
export const ModelsFile = z.strictObject({
  $schema: z.string().optional().describe('The JSON Schema of this file, for editors'),
  models: z
    .record(ModelAlias, ModelId)
    .describe('The model id or family behind each alias that brewers name'),
  brewers: z
    .record(PathSafeId, ModelAlias)
    .default({})
    .describe("An alias per brewer, replacing the brewer's own (blind tasting)"),
});

export const ModelsConfig = ModelsFile.superRefine((config, ctx) => {
  for (const [brewer, alias] of Object.entries(config.brewers)) {
    if (!Object.hasOwn(config.models, alias)) {
      ctx.addIssue({
        code: 'custom',
        message: `No model has the alias "${alias}"`,
        path: ['brewers', brewer],
      });
    }
  }
});
export type ModelsConfig = z.infer<typeof ModelsConfig>;
