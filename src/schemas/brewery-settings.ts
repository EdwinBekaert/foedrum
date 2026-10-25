// The Brewery's .claude/settings.json, as far as `foedrum init` writes it (ADR 0199): the plugin
// enabled for every session opened in the Brewery. Claude Code's other keys are kept as they are.

import { z } from './zod.ts';

export const BreweryClaudeSettings = z.looseObject({
  enabledPlugins: z
    .record(z.string().min(1), z.boolean())
    .optional()
    .describe('Each plugin by <name>@<marketplace>, enabled or not'),
});
export type BreweryClaudeSettings = z.infer<typeof BreweryClaudeSettings>;
