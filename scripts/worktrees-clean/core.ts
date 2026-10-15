// Decides what the worktree cleanup removes, from facts gathered by the shell (ADR 0021).

// clean or dirty: the folder is a worktree; no-git: the folder is there without its .git
// file; gone: only the record under .git/worktrees/ is left.
export type FolderState = 'clean' | 'dirty' | 'no-git' | 'gone';

export interface WorktreeFact {
  path: string;
  // The path below .claude/worktrees/ with `/` separators, or undefined outside it.
  inside: string | undefined;
  branch: string | undefined;
  lockReason: string | undefined;
  state: FolderState;
  record: string | undefined;
}

export interface BranchFact {
  name: string;
  merged: boolean;
  upstream: string | undefined;
  upstreamGone: boolean;
}

export interface Facts {
  worktrees: WorktreeFact[];
  branches: BranchFact[];
}

// `branch` on a worktree action is deleted after the action succeeds.
export type Action =
  | {
      kind: 'remove';
      label: string;
      path: string;
      record: string | undefined;
      unlock: boolean;
      branch: string | undefined;
    }
  | { kind: 'finish'; label: string; path: string; record: string; branch: string | undefined }
  | { kind: 'prune'; label: string; record: string; branch: string | undefined }
  | { kind: 'delete-branch'; branch: string };

export interface Plan {
  actions: Action[];
  kept: string[];
}

export const plan = (_facts: Facts, _isPidAlive: (pid: number) => boolean): Plan => {
  throw new Error('not implemented');
};
