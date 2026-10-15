// `node scripts/remove-scratch.ts <scratch>`: removes a brew-review scratch folder and the record
// under .git/worktrees/ of its tree through the platform removal (issue #61).

import { removeTree } from '../src/platform/remove.ts';
import { type Git, runGit } from './worktrees-clean.ts';

export const removeScratch = async (
  _cwd: string,
  _scratch: string,
  _git: Git = runGit,
  _remove: (path: string) => Promise<void> = removeTree,
): Promise<{ ok: boolean; lines: string[] }> => {
  throw new Error('not implemented');
};
