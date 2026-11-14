// The merged models.jsonc a test's attempts resolve their brewers through (ADR 0153, ADR 0397).

import type { ModelLevel, ModelsConfig } from '../../src/schemas/models.ts';

/** Foedrum's default translation of its efforts into Claude Code's (`defaults/models.jsonc`). */
export const CLAUDE_EFFORTS: ModelsConfig['claude']['efforts'] = {
  quick: 'low',
  steady: 'medium',
  careful: 'high',
  thorough: 'xhigh',
};

/** Models whose `claude` block maps `models` and Foedrum's default efforts, with `brewers` swaps. */
export const claudeModels = (
  models: Partial<Record<ModelLevel, string>>,
  brewers: Record<string, ModelLevel> = {},
): ModelsConfig => ({ claude: { models, efforts: CLAUDE_EFFORTS }, brewers });
