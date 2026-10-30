// The house-yeast rules as path-scoped Claude Code rule files, which Foedrum's own sessions load
// for the files they read or change (#677). scripts/generate-house-yeast-rules.ts writes them.

import type { RuleFile } from '../../src/brewers/house-yeast.ts';

export interface SessionRuleFile {
  name: string;
  text: string;
}

/** One rule file per set of paths, from the house-yeast rule files, and the rule files that are invalid. */
export const sessionRuleFiles = (
  _files: readonly RuleFile[],
): { files: SessionRuleFile[]; invalid: { path: string; reason: string }[] } => {
  throw new Error('not implemented');
};
