// models.jsonc: what a recipe step's model level and effort run as on each agent
// (brewers-and-recipes §5, ADR 0397).

import { z } from './zod.ts';

/** How strong a model a brewer step runs on, which models.jsonc names a model for (ADR 0397). */
export const ModelLevel = z.enum(['light', 'standard', 'strong', 'extreme']);
export type ModelLevel = z.infer<typeof ModelLevel>;

/** How hard a brewer step thinks, in Foedrum's words (ADR 0352, ADR 0397). */
export const Effort = z.enum(['small', 'moderate', 'larger', 'full']);
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
  // Not implemented: the red step's stub.
  tasted: z.never().optional(),
});

/** A models.jsonc: Foedrum's own, or a Brewery's that merges over it entry by entry (ADR 0153). */
export const ModelsConfig = z.strictObject({
  $schema: z.string().optional().describe('The JSON Schema of this file, for editors'),
  claude: ClaudeBlock.default({ models: {}, efforts: {} }).describe(
    "What Foedrum's levels and efforts are for the claude agent (ADR 0397)",
  ),
});
export type ModelsConfig = z.infer<typeof ModelsConfig>;
