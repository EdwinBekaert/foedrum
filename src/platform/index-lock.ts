// Stale `index.lock` cleanup (architecture §13, file locks). git creates `index.lock` in the git
// folder while it writes the index and deletes it when done; a git that is killed (at its
// deadline, or with its tree) leaves it behind, and every later git command that writes the
// index then fails with "Unable to create '…/index.lock': File exists". Run this only for a
// worktree no git command of this Foedrum is running in; the age guards against another one.

export type IndexLockCleanup = 'none' | 'fresh' | 'removed';

export interface IndexLockOptions {
  /** A lock at least this old is stale; default 60 s. */
  maxAgeMs?: number;
  now?: () => number;
}

/** Removes `<gitDir>/index.lock` when it is older than maxAgeMs, through removeTree. */
export const removeStaleIndexLock = async (
  _gitDir: string,
  _options: IndexLockOptions = {},
): Promise<IndexLockCleanup> => {
  throw new Error('not implemented');
};
