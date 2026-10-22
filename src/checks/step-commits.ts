// What a step of a batch committed, read with git (ADR 0078): the red proof finds the proven
// step's tests in it, and the testsUnchanged guard compares an attempt's changes with it.

import type { Batch } from '../engine/fold.ts';
import { ranIn } from '../engine/session-resume.ts';
import { type DiffFile, parseDiff } from '../formats/unified-diff.ts';
import { attemptBranch } from '../workspace/attempt-worktrees.ts';
import type { Git } from '../workspace/git.ts';

/**
 * The commits of step `stepId`: from where its first attempt started to the branch of its latest
 * attempt that succeeded (or of the worktree it resumed in), so a step a route sent back counts its earlier attempts' commits too;
 * undefined when none succeeded, as for a step the batch skipped.
 */
export function stepCommits(
  batch: Batch,
  stepId: string,
): { from: string; to: string } | undefined {
  const step = batch.steps.get(stepId);
  const attempts = [...(step?.attempts.values() ?? [])];
  const from = attempts
    .map((attempt) => (attempt.phase === 'scheduled' ? undefined : attempt.worktree?.commit))
    .find((commit) => commit !== undefined);
  const done = attempts.findLast(
    (attempt) => attempt.phase === 'finished' && attempt.outcome.kind === 'succeeded',
  );
  // A resumed attempt committed on the branch of the worktree its session ran in (ADR 0117).
  const ran = step === undefined || done === undefined ? undefined : ranIn(step, done);
  if (from === undefined || ran === undefined) return undefined;
  // Built from the attempt, never the recorded branch (ADR 0037).
  const branch = attemptBranch({ batchId: batch.id, stepId, attempt: ran.attempt });
  return { from, to: `refs/heads/${branch}` };
}

/** The last line of `text` that is not blank. */
const lastLine = (text: string): string | undefined =>
  text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .at(-1);

/** More than the runner's default 4 MiB: a large but ordinary change (fixtures, a lock file). */
const MAX_DIFF_BYTES = 16 * 1024 * 1024;

/**
 * The files changed from `from` to `to`, read in `cwd`, the repository's clone, whatever the user's diff settings, in
 * `paths` only when given; or why git could not read them.
 */
export async function readDiff(
  git: Git,
  cwd: string,
  range: { from: string; to: string },
  options: { signal?: AbortSignal; paths?: readonly string[] } = {},
): Promise<{ files: DiffFile[] } | { error: string }> {
  const { signal, paths = [] } = options;
  const args = [
    '-c',
    'core.quotePath=false',
    'diff',
    '--no-color',
    '--no-ext-diff',
    '--no-textconv',
    // A committed .gitattributes (`-diff`, `binary`) must not turn the tests into binary files.
    '--text',
    '--no-renames',
    '--unified=0',
    '--src-prefix=a/',
    '--dst-prefix=b/',
    range.from,
    range.to,
    '--',
    // A brewer names the files: a name that starts with ":" is no pathspec magic.
    ...paths.map((path) => `:(literal)${path}`),
  ];
  const result = await git(cwd, args, {
    maxOutputBytes: MAX_DIFF_BYTES,
    ...(signal === undefined ? {} : { signal }),
  });
  if (result.code !== 0) {
    return { error: lastLine(result.stderr) ?? `git exited with ${result.code ?? 'no code'}` };
  }
  return { files: parseDiff(result.stdout) };
}
