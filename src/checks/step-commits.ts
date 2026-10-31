// What a step of a batch committed, read with git (ADR 0078): the red proof finds the proven
// step's tests in it, and the testsUnchanged guard compares an attempt's changes with it.

import type { Batch } from '../engine/fold.ts';
import { ranIn } from '../engine/session-resume.ts';
import { type DiffFile, parseDiff } from '../formats/unified-diff.ts';
import { type GaugeReport, gaugeOf } from '../schemas/out-doc.ts';
import { attemptBranch } from '../workspace/attempt-worktrees.ts';
import type { Git } from '../workspace/git.ts';
import { declaresTest, isTestFile } from './tests-unchanged.ts';

/**
 * The commits of step `stepId`: from where its first attempt started to the branch of its latest
 * attempt that succeeded, or of the worktree that attempt resumed in, so a step a route sent back
 * counts its earlier attempts' commits too; undefined when none succeeded, as for a step the batch
 * skipped.
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

/**
 * The tests step `stepId` named in the out doc of its latest attempt that succeeded, the one whose
 * commits `stepCommits` ends at (ADR 0170); undefined when it named none.
 */
export function stepTests(batch: Batch, stepId: string): GaugeReport | undefined {
  const done = [...(batch.steps.get(stepId)?.attempts.values() ?? [])].findLast(
    (attempt) => attempt.phase === 'finished' && attempt.outcome.kind === 'succeeded',
  );
  return done?.phase === 'finished' && done.outcome.kind === 'succeeded'
    ? gaugeOf(done.outcome.output)
    : undefined;
}

/** The most files the red proof reads at the step's tip: the brewer's commits choose how many change. */
const MAX_TIP_READS = 50;

/** How long one read at the tip may take. */
const TIP_READ_MS = 10_000;

/**
 * The paths of `files` that declare a test at `to`, the proven step's tip, though no line the step
 * added to them does, such as a table it added a row to (ADR 0262); read in `cwd`, the clone, at
 * most `MAX_TIP_READS` of them. A file git cannot find there, one past the diff's limit, one that
 * is binary and one past that count is none; a read git was killed for otherwise throws.
 */
export async function readTestFiles(
  git: Git,
  cwd: string,
  to: string,
  files: readonly DiffFile[],
  signal?: AbortSignal,
): Promise<Set<string>> {
  const found = new Set<string>();
  // A deleted file is at no tip; a file whose added lines declare a test needs no read.
  const unread = files.filter((file) => file.newPath !== undefined && !isTestFile(file));
  for (const { newPath } of unread.slice(0, MAX_TIP_READS)) {
    if (newPath === undefined) continue;
    const result = await git(cwd, ['cat-file', 'blob', `${to}:${newPath}`], {
      maxOutputBytes: MAX_DIFF_BYTES,
      timeoutMs: TIP_READ_MS,
      ...(signal === undefined ? {} : { signal }),
    });
    if (result.code === null && result.killed !== 'too-much-output') {
      throw new Error(`git cat-file of ${newPath} was killed (${result.killed ?? 'no exit code'})`);
    }
    if (result.code !== 0 || result.stdout.includes('\0')) continue;
    if (result.stdout.split(/\r?\n/).some(declaresTest)) found.add(newPath);
  }
  return found;
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

/** The paths of every file at `commit`, read in `cwd`, the repository's clone; or why not. */
export async function readFilesAt(
  git: Git,
  cwd: string,
  commit: string,
  signal?: AbortSignal,
): Promise<{ files: string[] } | { error: string }> {
  const result = await git(cwd, ['ls-tree', '-r', '-z', '--name-only', commit, '--'], {
    maxOutputBytes: MAX_DIFF_BYTES,
    ...(signal === undefined ? {} : { signal }),
  });
  if (result.code !== 0) {
    return { error: lastLine(result.stderr) ?? `git exited with ${result.code ?? 'no code'}` };
  }
  return { files: result.stdout.split('\0').filter((path) => path !== '') };
}
