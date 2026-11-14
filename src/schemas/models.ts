// models.jsonc: what a brewer's model level and effort run as on each agent, and per-brewer
// overrides (brewers-and-recipes §5, ADR 0397).

import { PathSafeId } from './ids.ts';
import { z } from './zod.ts';

/** How strong a model a brewer runs on, which models.jsonc names a model for (ADR 0397). */
export const ModelLevel = z.enum(['light', 'standard', 'strong']);
export type ModelLevel = z.infer<typeof ModelLevel>;

/** A brewer's reasoning effort, or a step's that overrides it, in Foedrum's words (ADR 0352, ADR 0397). */
export const Effort = z.enum(['quick', 'steady', 'careful', 'thorough']);
export type Effort = z.infer<typeof Effort>;

/** Claude Code's effort words, which models.jsonc translates Foedrum's into (`claude --effort`). */
export const ClaudeEffort = z.enum(['low', 'medium', 'high', 'xhigh', 'max']);
export type ClaudeEffort = z.infer<typeof ClaudeEffort>;

// Passed to `claude --model`, which on Windows runs through a shell: no spaces, quotes or
// operators, and no leading dash that could read as an option.
export const ModelId = z
  .string()
  .regex(
    /^[a-z0-9][a-z0-9._:-]{0,127}(?:\[1m\])?$/,
    'Must be a model id or family such as "claude-sonnet-5-5" or "sonnet"',
  );

/** The `claude` agent's translations: a model per level and a Claude Code effort per effort. */
const ClaudeBlock = z.strictObject({
  models: z
    .partialRecord(ModelLevel, ModelId)
    .default({})
    .describe('The model id or family `claude --model` gets for each level'),
  efforts: z
    .partialRecord(Effort, ClaudeEffort)
    .default({})
    .describe("The word `claude --effort` gets for each of Foedrum's efforts"),
});

/**
 * The fields of a models.jsonc, without the check that its `brewers` name a level with a model: a
 * Brewery's file may leave that model to Foedrum's defaults, so serve checks it on the merged
 * models (ADR 0153).
 */
export const ModelsFile = z.strictObject({
  $schema: z.string().optional().describe('The JSON Schema of this file, for editors'),
  claude: ClaudeBlock.default({ models: {}, efforts: {} }).describe(
    "What Foedrum's levels and efforts are for the claude agent (ADR 0397)",
  ),
  brewers: z
    .record(PathSafeId, ModelLevel)
    .default({})
    .describe("A level per brewer, replacing the brewer's own (blind tasting)"),
});

export const ModelsConfig = ModelsFile.superRefine((config, ctx) => {
  for (const [brewer, level] of Object.entries(config.brewers)) {
    if (!Object.hasOwn(config.claude.models, level)) {
      ctx.addIssue({
        code: 'custom',
        message: `No model has the level "${level}"`,
        path: ['brewers', brewer],
      });
    }
  }
});
export type ModelsConfig = z.infer<typeof ModelsConfig>;
