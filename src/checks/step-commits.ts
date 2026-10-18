// What a step of a batch committed, read with git (ADR 0078): the red proof finds the proven
// step's tests in it, and the testsUnchanged guard compares an attempt's changes with it.

import type { Batch } from '../engine/fold.ts';
import { type DiffFile, parseDiff } from '../formats/unified-diff.ts';
import { attemptBranch } from '../workspace/attempt-worktrees.ts';
import type { Git } from '../workspace/git.ts';

/**
 * The commits of step `stepId`: from where its first attempt started to the branch of its latest
 * attempt that succeeded, so a step a route sent back counts its earlier attempts' commits too;
 * undefined when none succeeded, as for a step the batch skipped.
 */
export function stepCommits(
  batch: Batch,
  stepId: string,
): { from: string; to: string } | undefined {
  const attempts = [...(batch.steps.get(stepId)?.attempts.values() ?? [])];
  const first = attempts.find((attempt) => attempt.phase !== 'scheduled' && attempt.worktree);
  const done = attempts.findLast(
    (attempt) => attempt.phase === 'finished' && attempt.outcome.kind === 'succeeded',
  );
  if (first === undefined || first.phase === 'scheduled' || done === undefined) return undefined;
  const from = first.worktree?.commit;
  if (from === undefined) return undefined;
  // Built from the attempt, never the recorded branch (ADR 0037).
  const branch = attemptBranch({ batchId: batch.id, stepId, attempt: done.attempt });
  return { from, to: `refs/heads/${branch}` };
}

/** The last line of `text` that is not blank. */
const lastLine = (text: string): string | undefined =>
  text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .at(-1);

/**
 * The files changed from `from` to `to`, read in `cwd`, whatever the user's diff settings; or why
 * git could not read them.
 */
export async function readDiff(
  git: Git,
  cwd: string,
  range: { from: string; to: string },
  signal?: AbortSignal,
): Promise<{ files: DiffFile[] } | { error: string }> {
  const args = [
    '-c',
    'core.quotePath=false',
    'diff',
    '--no-color',
    '--no-ext-diff',
    '--no-textconv',
    '--no-renames',
    '--unified=0',
    '--src-prefix=a/',
    '--dst-prefix=b/',
    range.from,
    range.to,
    '--',
  ];
  const result = await git(cwd, args, signal === undefined ? {} : { signal });
  if (result.code !== 0) {
    return { error: lastLine(result.stderr) ?? `git exited with ${result.code ?? 'no code'}` };
  }
  return { files: parseDiff(result.stdout) };
}
