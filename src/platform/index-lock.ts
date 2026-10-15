// Stale `index.lock` cleanup (architecture §13, file locks). git creates `index.lock` in the git
// folder while it writes the index and deletes it when done; a git that is killed (at its
// deadline, or with its tree) leaves it behind, and every later git command that writes the
// index then fails with "Unable to create '…/index.lock': File exists". Run this only for a
// worktree no git command of this Foedrum is running in; the age guards against another one.

import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { errorCode, removeTree } from './remove.ts';

export type IndexLockCleanup = 'none' | 'fresh' | 'removed';

export interface IndexLockOptions {
  /** A lock at least this old is stale; default 60 s. */
  maxAgeMs?: number;
  now?: () => number;
}

/** Removes `<gitDir>/index.lock` when it is older than maxAgeMs, through removeTree. */
export const removeStaleIndexLock = async (
  gitDir: string,
  { maxAgeMs = 60_000, now = Date.now }: IndexLockOptions = {},
): Promise<IndexLockCleanup> => {
  const lock = join(gitDir, 'index.lock');
  let written: number;
  try {
    written = (await stat(lock)).mtimeMs;
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return 'none';
    throw error;
  }
  if (now() - written < maxAgeMs) return 'fresh';
  await removeTree(lock);
  return 'removed';
};
