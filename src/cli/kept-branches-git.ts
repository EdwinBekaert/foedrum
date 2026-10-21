// Reads the task-tree branches the cleanup keeps (ADR 0084, ADR 0092) for `foedrum status`: each
// branch's tip and its commits past the batch's start, through the engine's git in the clone the
// attempt worktrees are added to, never in a worktree a brewer wrote. kept-branches.ts decides.

import type { State } from '../engine/fold.ts';
import { parseAttemptBranch } from '../workspace/attempt-worktrees.ts';
import type { Git, GitResult } from '../workspace/git.ts';
import type { BranchReading } from './kept-branches.ts';

export interface KeptBranchesShell {
  git: Git;
  /** The clone a repository's attempt worktrees are added to, or undefined when none is known. */
  cloneOf: (repo: string) => string | undefined;
}

class Unread extends Error {}

const firstLine = (text: string): string =>
  text
    .split(/\r?\n/)
    .find((line) => line.trim() !== '')
    ?.trim() ?? '';

// git's output, or Unread with the first line of why it failed.
const output = async (
  git: Git,
  clone: string,
  args: string[],
  quietMiss = false,
): Promise<GitResult> => {
  const failed = (why: string) => new Unread(`git ${args[0]} in ${clone} failed: ${why}`);
  let result: GitResult;
  try {
    result = await git(clone, args);
  } catch (error) {
    throw failed(error instanceof Error ? error.message : String(error));
  }
  // `rev-parse --verify --quiet` says nothing when the ref is not there.
  if (result.code === 0 || (quietMiss && result.code === 1 && result.stderr === '')) return result;
  throw failed(firstLine(result.stderr) || `git exited with ${result.code}`);
};

const readOne = async (
  state: State,
  branch: string,
  start: string,
  { git, cloneOf }: KeptBranchesShell,
): Promise<BranchReading> => {
  const attemptRef = parseAttemptBranch(branch);
  const batchId = attemptRef?.batchId ?? '';
  const batch = state.batches.get(batchId);
  const { taskTree } = batch ?? {};
  // A rewound task tree is held by an attempt's branch, in the repository that attempt wrote in.
  const attempt =
    attemptRef && batch?.steps.get(attemptRef.stepId)?.attempts.get(attemptRef.attempt);
  const repo =
    taskTree?.kind === 'attempt'
      ? taskTree.repo
      : taskTree?.kind === 'rewound' && attempt !== undefined && attempt.phase !== 'scheduled'
        ? attempt.worktree?.repo
        : undefined;
  if (repo === undefined) {
    return { kind: 'unread', reason: `no task tree of batch ${batchId} in the event store` };
  }
  const clone = cloneOf(repo);
  if (clone === undefined) {
    return {
      kind: 'unread',
      reason: `no clone for ${repo} in foedrum.jsonc and .foedrum/local.jsonc`,
    };
  }
  try {
    const ref = `refs/heads/${branch}`;
    const tipped = await output(git, clone, ['rev-parse', '--verify', '--quiet', ref], true);
    if (tipped.code !== 0) return { kind: 'gone' };
    const tip = tipped.stdout.trim();
    if (start === '' || tip === start) {
      return { kind: 'read', clone, tip, ahead: start === '' ? undefined : 0 };
    }
    const counted = await output(git, clone, ['rev-list', '--count', `${start}..${tip}`]);
    return { kind: 'read', clone, tip, ahead: Number(counted.stdout.trim()) };
  } catch (error) {
    if (error instanceof Unread) return { kind: 'unread', reason: error.message };
    throw error;
  }
};

/** What git says of each branch of `unpushed` (`Claims.unpushed`), by name. */
export const readKeptBranches = async (
  state: State,
  unpushed: ReadonlyMap<string, string>,
  shell: KeptBranchesShell,
): Promise<Map<string, BranchReading>> => {
  const readings = new Map<string, BranchReading>();
  for (const [branch, start] of unpushed) {
    readings.set(branch, await readOne(state, branch, start, shell));
  }
  return readings;
};
