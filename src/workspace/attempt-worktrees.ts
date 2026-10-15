// Decides where an attempt's worktree lives, whether it can be created or recreated, and what a
// cleanup removes (ADR 0012, ADR 0029). Pure: attempt-worktrees-git.ts gathers the facts from git
// and carries the decisions out (ADR 0021).

import type { FolderState, Removal } from './worktree-removal.ts';

/** One attempt of a step of a batch; the same shape as the engine's `AttemptRef`. */
export interface AttemptRef {
  batchId: string;
  stepId: string;
  attempt: number;
}

/** The folder of a repository under the work root: `<owner>.<name>`, lower case. */
export const repoFolder = (_repo: string): string => {
  throw new Error('not implemented');
};

/** The local branch of an attempt: `foedrum/<batchId>/<stepId>/<attempt>`. */
export const attemptBranch = (_ref: AttemptRef): string => {
  throw new Error('not implemented');
};

/** The attempt whose branch this is, or undefined for any other branch. */
export const parseAttemptBranch = (_name: string): AttemptRef | undefined => {
  throw new Error('not implemented');
};

/** The folder of an attempt below the attempts root, with `/` separators. */
export const attemptFolder = (_ref: AttemptRef): string => {
  throw new Error('not implemented');
};

/** The attempt whose folder this is (below the attempts root, `/` separators), or undefined. */
export const parseAttemptFolder = (_inside: string): AttemptRef | undefined => {
  throw new Error('not implemented');
};

/** A worktree git lists for the clone. */
export interface ListedFact {
  path: string;
  /** The path below the attempts root with `/` separators, or undefined outside it. */
  inside: string | undefined;
  branch: string | undefined;
  lockReason: string | undefined;
  /** `unchecked` outside the attempts root. */
  state: FolderState;
  record: string | undefined;
}

/** A local branch under `refs/heads/foedrum/`. */
export interface BranchFact {
  name: string;
  tip: string;
}

/** A batch folder under the attempts root and the attempt folders found below it. */
export interface BatchFolderFact {
  batchId: string;
  /** `<stepId>/<attempt>` of every folder two levels below the batch folder. */
  attempts: string[];
}

export interface Facts {
  worktrees: ListedFact[];
  branches: BranchFact[];
  folders: BatchFolderFact[];
}

/**
 * What the engine's state says about the worktrees: whether each batch it knows is still live
 * (it may brew again: ordered, brewing, conditioning or Stuck) or has ended (on tap or
 * cancelled), and which attempts hold a live lease.
 */
export interface Claims {
  batches: ReadonlyMap<string, 'live' | 'ended'>;
  leased: readonly AttemptRef[];
}

export type Action =
  /** `branch` is deleted once the worktree is gone. */
  | (Removal & { label: string; branch: BranchFact | undefined })
  /** A folder under the attempts root that git does not know as a worktree. */
  | { kind: 'remove-folder'; label: string; path: string }
  /** A batch folder whose attempts all went; removed only when it is empty by then. */
  | { kind: 'remove-batch-folder'; label: string; path: string }
  /** Deleted only while it still points at `tip`. */
  | { kind: 'delete-branch'; branch: string; tip: string }
  /** A kept worktree no attempt runs in: its stale index.lock goes. */
  | { kind: 'index-lock'; label: string; gitDir: string };

export interface Plan {
  actions: Action[];
  kept: string[];
}

/**
 * What a cleanup removes, from the facts of one clone and the claims. With `batchId`, only that
 * batch's worktrees, folders and branches are looked at (the batch has ended).
 */
export const planClean = (
  _facts: Facts,
  _claims: Claims,
  _root: string,
  _scope: { batchId?: string } = {},
): Plan => {
  throw new Error('not implemented');
};

/** What an attempt's worktree is to start from. */
export type Target =
  /** A new attempt, at the base commit. */
  | { kind: 'new'; base: string }
  /** A resumed attempt, at its recorded commit when its branch is gone (ADR 0019). */
  | { kind: 'resume'; commit: string };

/** The facts about one attempt's folder and branch. */
export interface AttemptFacts {
  /** The worktree git lists at the attempt's folder. */
  listed: ListedFact | undefined;
  /** Whether anything is on disk at the attempt's folder. */
  folderExists: boolean;
  /** The attempt branch's commit, when the branch exists. */
  branchTip: string | undefined;
  /** Where another worktree has the attempt's branch checked out. */
  checkedOutAt: string | undefined;
}

export type WorktreePlan =
  /** The worktree is there already. */
  | { kind: 'reuse' }
  /** `git worktree add`, after pruning a stale record; `newBranch` creates the branch at `at`. */
  | { kind: 'add'; prune: string | undefined; newBranch: boolean; at: string }
  | { kind: 'refuse'; reason: string };

/** How an attempt gets its worktree. */
export const planWorktree = (
  _ref: AttemptRef,
  _facts: AttemptFacts,
  _target: Target,
): WorktreePlan => {
  throw new Error('not implemented');
};
