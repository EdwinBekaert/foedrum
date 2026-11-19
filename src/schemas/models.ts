// models.jsonc: what a recipe step's model level and effort run as on each agent
// (brewers-and-recipes §5, ADR 0397).

import { PathSafeId } from './ids.ts';
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

/** How many orders a Flight passed every run of, out of the orders both Flights measured. */
const OrderCount = z.number().int().nonnegative();

/** A mean count of tokens of one kind per order, rounded to a whole token. */
const TokenCount = z.number().int().nonnegative();

/** The latest Flight of a brewer, recipe, level and effort, won or lost (ADR 0416). */
export const TastedEntry = z.strictObject({
  brewer: PathSafeId,
  recipe: PathSafeId,
  level: ModelLevel,
  effort: Effort,
  model: ModelId.describe('The exact model id the candidate Flight’s transcripts named'),
  passed: OrderCount.describe('The orders the candidate passed in every run'),
  runs: OrderCount.describe('The orders both Flights measured, not the runs brewed'),
  baseline: z
    .strictObject({
      passed: OrderCount.describe('The orders the baseline passed in every run'),
      runs: OrderCount.describe('The orders both Flights measured, not the runs brewed'),
      model: ModelId.describe('The exact model id the baseline Flight’s transcripts named'),
    })
    .describe('The Flight the candidate was compared with'),
  tokensPerOrder: z.number().int().nonnegative(),
  tokensPerOrderSplit: z
    .strictObject({
      output: TokenCount,
      cacheRead: TokenCount,
      cacheWrite: TokenCount,
      input: TokenCount.describe('Fresh input, which the cache neither read nor wrote'),
    })
    .optional()
    .describe('The candidate’s tokens per order by kind, as a later token guess needs them apart'),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be a date such as "2026-11-20"'),
  report: z
    .url({ protocol: /^https$/ })
    .optional()
    .describe('The pull request that holds the Flight report'),
});
export type TastedEntry = z.infer<typeof TastedEntry>;

/** The combination a tasted entry is the latest of, which the merge keys entries by. */
export const tastedKey = ({ brewer, recipe, level, effort }: TastedEntry): string =>
  `${brewer} in ${recipe} on ${level} at ${effort}`;

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
  tasted: z
    .array(TastedEntry)
    .default([])
    .superRefine((entries, context) => {
      const seen = new Set<string>();
      for (const entry of entries) {
        const key = tastedKey(entry);
        if (seen.has(key)) context.addIssue({ code: 'custom', message: `${key} is tasted twice` });
        seen.add(key);
      }
    })
    .describe('The latest Flight of each brewer, recipe, level and effort (ADR 0416)'),
});

/** A models.jsonc: Foedrum's own, or a Brewery's that merges over it entry by entry (ADR 0153). */
export const ModelsConfig = z.strictObject({
  $schema: z.string().optional().describe('The JSON Schema of this file, for editors'),
  claude: ClaudeBlock.default({ models: {}, efforts: {}, tasted: [] }).describe(
    "What Foedrum's levels and efforts are for the claude agent (ADR 0397)",
  ),
});
export type ModelsConfig = z.infer<typeof ModelsConfig>;
