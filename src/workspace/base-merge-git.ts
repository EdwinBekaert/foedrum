// The merge of the base before a batch's last check (ADR 0164), the shell: git in the check
// attempt's worktree, with no hook or fsmonitor (ADR 0137). Git runs only through the injected
// `Git`, so unit tests pass a fake one (ADR 0021).

import type { WorktreeMerge } from '../engine/base-merge.ts';
import type { Git } from './git.ts';

export const openWorktreeMerge = (_git: Git): WorktreeMerge => {
  throw new Error('not implemented');
};
