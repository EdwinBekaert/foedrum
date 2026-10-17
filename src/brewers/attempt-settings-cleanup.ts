// The attempt settings files go with their batch's worktrees (ADR 0063): `claude` reads its
// settings once, when it starts, so a batch that ended needs none of its files any more.

import type { RemovePath } from '../platform/remove.ts';
import type { AttemptWorktrees } from '../workspace/attempt-worktrees-git.ts';

/** Removes the settings folders under `<workRoot>/attempt-settings` that no live batch claims. */
export const attemptSettingsCleaner = (
  _workRoot: string,
  _remove?: RemovePath,
): Pick<AttemptWorktrees, 'root' | 'clean'> => {
  throw new Error('not implemented');
};
