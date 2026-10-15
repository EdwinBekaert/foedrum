// Decides what the worktree cleanup removes, from facts gathered by the shell (ADR 0021).

// clean or dirty: the folder is a worktree; no-git: the folder is there without its .git
// file; gone: only the record under .git/worktrees/ is left; unchecked: outside
// .claude/worktrees/, so never looked at.
export type FolderState = 'clean' | 'dirty' | 'no-git' | 'gone' | 'unchecked';

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

// By hand it always runs; at session start only in the main checkout. git says which that is
// (its git dir is the common dir), whatever link, junction or subst drive it was opened through.
export const shouldRun = (
  sessionStart: boolean,
  dirs: { gitDir: string; commonDir: string } | undefined,
): boolean => dirs !== undefined && (!sessionStart || dirs.gitDir === dirs.commonDir);

const BASE = 'origin/main';
// The lock reason Claude Code writes for a session's worktree.
const SESSION_LOCK = /^claude session .+ \(pid (\d+)\)$/;

// A branch may go once it is merged and GitHub has deleted its remote branch, which it does
// on merge. Without an upstream of its own (never pushed, or tracking origin/main) it stays,
// so main and long-lived local branches are never deleted.
const branchKeepReason = (branch: BranchFact | undefined): string | undefined => {
  if (branch === undefined) return 'no branch';
  if (!branch.merged) return `not merged into ${BASE}`;
  if (branch.upstream === undefined || branch.upstream === BASE) {
    return 'no upstream branch of its own';
  }
  return branch.upstreamGone ? undefined : 'its remote branch still exists';
};

const lockKeepReason = (lock: string | undefined, isPidAlive: (pid: number) => boolean) => {
  if (lock === undefined) return undefined;
  const pid = SESSION_LOCK.exec(lock)?.[1];
  if (pid === undefined) return `locked: ${lock || 'no reason given'}`;
  return isPidAlive(Number(pid)) ? `locked by a live session (pid ${pid})` : undefined;
};

export const plan = (facts: Facts, isPidAlive: (pid: number) => boolean): Plan => {
  const branches = new Map(facts.branches.map((branch) => [branch.name, branch]));
  const actions: Action[] = [];
  const kept: string[] = [];

  for (const worktree of facts.worktrees) {
    const { inside, path, record, state } = worktree;
    // Nested worktrees, such as review scratch trees, only have their stale records pruned.
    if (inside === undefined || (inside.includes('/') && state !== 'gone')) continue;
    const label = `.claude/worktrees/${inside}`;
    const branchReason = branchKeepReason(branches.get(worktree.branch ?? ''));
    const branch = branchReason === undefined ? worktree.branch : undefined;
    // Removing the folder would take a nested worktree with it, dirty or in use.
    const nested = facts.worktrees.find(
      (other) => other.state !== 'gone' && other.inside?.startsWith(`${inside}/`),
    );
    const reason =
      (nested === undefined
        ? undefined
        : `it contains the worktree .claude/worktrees/${nested.inside}`) ??
      lockKeepReason(worktree.lockReason, isPidAlive) ??
      (state === 'dirty' ? 'it has uncommitted or untracked changes' : undefined) ??
      (state === 'gone' ? undefined : branchReason);
    if (reason !== undefined) kept.push(`kept worktree ${label}: ${reason}`);
    else if (state === 'gone' && record !== undefined) {
      actions.push({ kind: 'prune', label, record, branch });
    } else if (state === 'no-git' && record !== undefined) {
      actions.push({ kind: 'finish', label, path, record, branch });
    } else if (state === 'clean') {
      const unlock = worktree.lockReason !== undefined;
      actions.push({ kind: 'remove', label, path, record, unlock, branch });
    } else {
      kept.push(`kept worktree ${label}: no record under .git/worktrees/ points at it`);
    }
  }

  const checkedOut = new Set(facts.worktrees.map((worktree) => worktree.branch));
  for (const branch of facts.branches) {
    if (checkedOut.has(branch.name)) continue;
    const reason = branchKeepReason(branch);
    if (reason === undefined) actions.push({ kind: 'delete-branch', branch: branch.name });
    else kept.push(`kept branch ${branch.name}: ${reason}`);
  }
  return { actions, kept };
};
