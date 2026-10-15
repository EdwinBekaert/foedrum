// The attempt worktree manager's shell (ADR 0012, ADR 0029): gathers facts from git and the
// attempts root, and carries out what attempt-worktrees.ts decides. Git runs only through the
// injected `Git`, so unit tests pass a fake one (ADR 0021).

import type { AttemptRef, Claims } from './attempt-worktrees.ts';
import type { Git } from './git.ts';

export interface AttemptWorktreesOptions {
  git: Git;
  /** Foedrum's work root, outside the Brewery checkout (default `~/.foedrum/<brewery>/`). */
  workRoot: string;
  /** `owner/name` of the repository the attempts write in. */
  repo: string;
  /**
   * The repository the worktrees are added to: the user's clone (`source: local`) or the
   * managed clone (`source: managed`, from `ensureManagedClone`).
   */
  clone: string;
  /** Default `origin`. */
  remote?: string;
  /** The clock for the age of a stale index.lock. */
  now?: () => number;
}

/** An attempt's worktree: where it is, its branch, and the commit it was at when made. */
export interface AttemptWorktree {
  path: string;
  branch: string;
  commit: string;
}

/** One line per item: what a cleanup removed, kept (with the reason) and could not remove. */
export interface CleanReport {
  done: string[];
  kept: string[];
  failed: string[];
}

export interface AttemptWorktrees {
  /** The folder the repository's attempt worktrees live in. */
  readonly root: string;
  /**
   * Fetches, then gives a new attempt its worktree on its own branch at `base` (a commit or a
   * ref such as `origin/main`). Call it only for an attempt whose lease the caller holds and
   * that has not started. Throws when something of the attempt is in the way.
   */
  create(ref: AttemptRef, base: string): Promise<AttemptWorktree>;
  /**
   * Gives a resumed attempt its worktree back (ADR 0019): the one that is there, or a new one on
   * its branch, or at `commit` when the branch is gone. Throws when that cannot be done.
   */
  recreate(ref: AttemptRef, commit: string): Promise<AttemptWorktree>;
  /**
   * Removes the worktrees, folders and local branches that nothing claims, and stale index.lock
   * files of kept worktrees no attempt runs in. At engine start without `batchId` (crash
   * repair); with it, when that batch has ended.
   */
  clean(claims: Claims, scope?: { batchId?: string }): Promise<CleanReport>;
}

export const openAttemptWorktrees = (_options: AttemptWorktreesOptions): AttemptWorktrees => {
  throw new Error('not implemented');
};

export interface ManagedCloneOptions {
  git: Git;
  workRoot: string;
  repo: string;
  /** Where to clone from. */
  url: string;
  /** A local clone to borrow objects from (`--reference`). */
  reference?: string;
}

/**
 * The repository's managed clone (`source: managed`, ADR 0012): a bare partial clone in the work
 * root, made once. Returns its path.
 */
export const ensureManagedClone = async (_options: ManagedCloneOptions): Promise<string> => {
  throw new Error('not implemented');
};
