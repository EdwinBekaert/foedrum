// .foedrum/local.jsonc: what one machine says about a Brewery, git-ignored next to its event store
// (ADR 0063).

import { z } from './zod.ts';

export interface LocalConfig {
  /** The work root (ADR 0037); default `<home>/.foedrum/<owner>.<name>`. */
  workRoot?: string;
  /** The user's clone of each target repository, by owner/name. */
  clones: Record<string, string>;
}

// Not implemented yet (#162): refuses everything.
export const LocalConfig: z.ZodType<LocalConfig> = z.never();
