// The attempt settings files go with their batch's worktrees (ADR 0063): `claude` reads its
// settings once, when it starts, so a batch that ended needs none of its files any more.

import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { errorCode, type RemovePath, removeTree } from '../platform/remove.ts';
import type { AttemptWorktrees, CleanReport } from '../workspace/attempt-worktrees-git.ts';

/** The batch folders under `root`; none when no attempt wrote settings yet. */
const batchFolders = async (root: string): Promise<string[]> => {
  try {
    const entries = await readdir(root, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return [];
    throw error;
  }
};

/**
 * Removes the settings folders under `<workRoot>/attempt-settings` that no live batch claims: the
 * one of `scope.batchId` when it has ended, or every ended and unknown batch's at a repair.
 */
export const attemptSettingsCleaner = (
  workRoot: string,
  remove: RemovePath = removeTree,
): Pick<AttemptWorktrees, 'root' | 'clean'> => {
  const root = join(workRoot, 'attempt-settings');
  return {
    root,
    async clean(claims, scope = {}) {
      const report: CleanReport = { done: [], kept: [], failed: [] };
      for (const batchId of await batchFolders(root)) {
        if (scope.batchId !== undefined && batchId !== scope.batchId) continue;
        if (claims.batches.get(batchId) === 'live') continue;
        try {
          await remove(join(root, batchId));
          report.done.push(`removed attempt settings ${batchId}`);
        } catch (error) {
          report.failed.push(
            `could not clean attempt settings ${batchId}: ${(error as Error).message}`,
          );
        }
      }
      return report;
    },
  };
};
