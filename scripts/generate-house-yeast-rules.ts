// Regenerates the session rule files in .claude/rules/house-yeast/ from the house-yeast rules in
// .foedrum/house-yeast/ (npm run house-yeast:rules; #677, ADR 0271), as record does when it
// proposes a rule.

import { join, sep } from 'node:path';
import { processDeps, regenerateSessionRules } from './house-yeast.ts';

const rules = join(import.meta.dirname, '..', '.foedrum', 'house-yeast')
  .split(sep)
  .join('/');
process.exitCode = regenerateSessionRules(rules, processDeps);
