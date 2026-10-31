// The testsUnchanged guard, the shell (ADR 0017, ADR 0078, ADR 0274): around the brewer runner,
// once an attempt of a guarded step succeeded, it reads from git what the proven step committed,
// what the attempt changed and the repository's test maps, and fails the attempt when it changed or
// removed a line the step added to a separate test file of the map, or with no map, a test
// declaration or assertion. tests-unchanged.ts decides.

import { type AttemptRef, attemptKey } from '../engine/attempt-key.ts';
import { mergedBase } from '../engine/base-merge.ts';
import type { AttemptEnd, AttemptStart, BrewerRunner } from '../engine/brewer-runner.ts';
import type { State } from '../engine/fold.ts';
import { ranIn } from '../engine/session-resume.ts';
import type { AttemptProgress } from '../engine/supervisor.ts';
import type { DiffFile } from '../formats/unified-diff.ts';
import { foldsCase } from '../platform/paths.ts';
import type { TestMap } from '../schemas/test-map.ts';
import { attemptBranch } from '../workspace/attempt-worktrees.ts';
import type { Git, GitResult } from '../workspace/git.ts';
import { cut } from './red-proof.ts';
import { readDiff, stepCommits } from './step-commits.ts';
import { effectiveMap, type ReadTestMapAt } from './test-map.ts';
import {
  type ChangedTestLine,
  changedTestLines,
  changedTests,
  guardedFiles,
} from './tests-unchanged.ts';

/**
 * Which lines the proven step committed, `proven`, an attempt's `changes` changed or removed; or
 * why git could not read what it needed to tell.
 */
type Keep = (
  proven: readonly DiffFile[],
  changes: readonly DiffFile[],
) => Promise<ChangedTestLine[] | { error: string }>;

/** As much as a diff of the step may hold: a test file at the tip is read with the same bound. */
const MAX_TIP_BYTES = 16 * 1024 * 1024;

/** How long one read at the attempt's tip may take. */
const TIP_READ_MS = 10_000;

/** Why git failed: its last line on stderr, or how it ended. */
const failure = (args: string, result: GitResult): string =>
  result.stderr
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .at(-1) ?? `git ${args} exited with ${result.code ?? result.killed ?? 'no code'}`;

/**
 * The text of each of `paths` at `ref`, read in `cwd`, the clone, by the blob `ls-tree` names
 * there; a path that is no file there is absent. Or why git could not read them.
 */
async function readTip(
  git: Git,
  cwd: string,
  ref: string,
  paths: readonly string[],
  signal: AbortSignal,
): Promise<{ files: Map<string, string> } | { error: string }> {
  const files = new Map<string, string>();
  if (paths.length === 0) return { files };
  const options = { maxOutputBytes: MAX_TIP_BYTES, timeoutMs: TIP_READ_MS, signal };
  const listed = await git(cwd, ['ls-tree', '-z', '--full-tree', ref, '--', ...paths], options);
  if (listed.code !== 0) return { error: failure('ls-tree', listed) };
  for (const entry of listed.stdout.split('\0')) {
    const [, blob, path] = /^\d+ blob ([0-9a-f]+)\t(.+)$/s.exec(entry) ?? [];
    // A pattern ls-tree matched past the paths asked for is not one of them.
    if (blob === undefined || path === undefined || !paths.includes(path)) continue;
    const read = await git(cwd, ['cat-file', 'blob', blob], options);
    if (read.code !== 0) return { error: failure('cat-file', read) };
    files.set(path, read.stdout);
  }
  return { files };
}

export interface TestsGuardOptions {
  runner: BrewerRunner;
  /** The folded state: the driver's, which has recorded the attempt's start and worktree. */
  state: () => State;
  /**
   * The step whose tests attempt `ref` must keep: its recipe's red proof's, when its brewer has
   * the testsUnchanged guard; else undefined.
   */
  protects: (ref: AttemptRef) => string | undefined;
  git: Git;
  /**
   * The clone a repository's attempt worktrees are added to, where git reads the commits: never
   * the attempt's worktree, whose `.git` file its brewer can rewrite.
   */
  clone: (repo: string) => string;
  /**
   * A repository's test map by commit (ADR 0274): where the base's or the proven step's map lists
   * modules, the attempt keeps every line the step added to their separate test files. Absent, or
   * no map at either, the guard keeps the step's test declarations and assertions (ADR 0078).
   */
  testMap?: ReadTestMapAt;
  /** Whose file system's case rule the map's globs are matched by. Default this process's. */
  platform?: NodeJS.Platform;
  /** Default the system clock. */
  clock?: () => Date;
}

export function guardTests(options: TestsGuardOptions): BrewerRunner {
  const {
    runner,
    state,
    protects,
    git,
    clone,
    testMap,
    platform,
    clock = () => new Date(),
  } = options;
  // The attempts whose commits it is reading: it reports their progress, so their leases hold.
  const checking = new Map<string, AttemptProgress>();

  /** `end`, or how the guard ends the attempt instead. */
  const guard = async (
    ref: AttemptRef,
    end: AttemptEnd,
    signal: AbortSignal,
  ): Promise<AttemptEnd> => {
    if (end.ending.kind !== 'succeeded') return end;
    const of = protects(ref);
    if (of === undefined) return end;
    const batch = state().batches.get(ref.batchId);
    const step = batch?.steps.get(ref.stepId);
    const current = step?.attempts.get(ref.attempt);
    // Its own worktree, or for a resumed attempt the one its session ran in, whose maker's branch
    // carries the changes of every attempt of that session (ADR 0117).
    const ran = step === undefined || current === undefined ? undefined : ranIn(step, current);
    // Without a worktree the attempt changed nothing the guard could read.
    if (batch === undefined || ran === undefined) return end;
    const { worktree } = ran;
    // A step the batch skipped, or that never succeeded, committed no tests to keep.
    const proven = stepCommits(batch, of);
    if (proven === undefined) return end;
    const key = attemptKey.encode(ref);
    checking.set(key, { lastProgressAt: clock(), turnsWithoutProgress: 0 });
    // What the proven step committed, then what this attempt committed on top of where it started,
    // in the clone: never by discovery in the worktree, whose .git file the brewer can rewrite.
    const cwd = clone(worktree.repo);
    // Its branch, which the task tree carries on whatever HEAD is (ADR 0066).
    const tip = `refs/heads/${attemptBranch({ ...ref, attempt: ran.attempt })}`;
    const read = async () => {
      const tests = await readDiff(git, cwd, proven, { signal });
      if ('error' in tests) return tests;
      // Up to its branch, and only in the files whose lines the guard keeps.
      const own = { from: worktree.commit, to: tip };
      const paths = tests.files.flatMap(({ newPath }) => (newPath === undefined ? [] : [newPath]));
      const changes = await readDiff(git, cwd, own, { signal, paths });
      return 'error' in changes ? changes : { tests: tests.files, changes: changes.files };
    };
    // What it keeps: by the map where the base's or the proven step's lists modules (ADR 0274),
    // else the declarations and assertions (ADR 0078); or why a map cannot be read.
    const keeping = async (): Promise<{ keep: Keep } | { summary: string }> => {
      const today: Keep = (tests, changes) => Promise.resolve(changedTests(tests, changes));
      if (testMap === undefined) return { keep: today };
      const { repo } = worktree;
      // The base the batch's change starts from (ADR 0164), and the map the proven step committed,
      // which a later attempt cannot narrow.
      const base = mergedBase(state(), batch.id) ?? batch.starts?.[repo.toLowerCase()]?.commit;
      const maps: (TestMap | undefined)[] = [];
      for (const commit of [base, proven.to]) {
        const map =
          commit === undefined ? { kind: 'none' as const } : await testMap(repo, commit, signal);
        if (map.kind === 'unreadable') {
          return {
            summary: `the guard testsUnchanged cannot read the test map of ${repo} at ${commit}: ${map.reason}`,
          };
        }
        maps.push(map.kind === 'map' ? map.map : undefined);
      }
      const [atBase, atStep] = maps;
      if (atBase === undefined && atStep === undefined) return { keep: today };
      // Every module the base lists stays: the guard keeps more, never less, than the map says.
      const fold = foldsCase(platform);
      const modules = effectiveMap(atBase, atStep, { atBase: [], deleted: [] }, fold);
      // A map only the batch has keeps, where it guards nothing, what no map keeps.
      const options = { foldCase: fold, newMap: atBase === undefined };
      return {
        keep: async (tests, changes) => {
          // Each test file as the attempt left it, so a later step's own copy of a line may go.
          const files = await readTip(git, cwd, tip, guardedFiles(tests, modules, fold), signal);
          if ('error' in files) return files;
          return changedTestLines(
            tests,
            { files: files.files, before: new Map(), changes },
            modules,
            options,
          );
        },
      };
    };
    try {
      const kept = await keeping();
      if (signal.aborted) return { ...end, ending: { kind: 'cancelled' } };
      if ('summary' in kept) {
        return {
          ...end,
          ending: { kind: 'blocked', blockerKind: 'environment', summary: kept.summary },
        };
      }
      const unreadable = (error: string): AttemptEnd => {
        const summary = `the guard testsUnchanged cannot read the commits of step ${ref.stepId}: ${error}`;
        return { ...end, ending: { kind: 'blocked', blockerKind: 'environment', summary } };
      };
      const diffs = await read();
      if (signal.aborted) return { ...end, ending: { kind: 'cancelled' } };
      if ('error' in diffs) return unreadable(diffs.error);
      const changed = await kept.keep(diffs.tests, diffs.changes);
      if (signal.aborted) return { ...end, ending: { kind: 'cancelled' } };
      if ('error' in changed) return unreadable(changed.error);
      const [first] = changed;
      if (first === undefined) return end;
      const lines = changed.length === 1 ? 'a line' : `${changed.length} lines`;
      const more = changed.length > 1 ? ` (and ${changed.length - 1} more)` : '';
      const reason = `the guard testsUnchanged: the attempt changed or removed ${lines} of the tests of step ${of}, ${first.path}: ${cut(first.line)}${more}`;
      // Another attempt starts afresh at the task tree, and may keep the tests.
      return { ...end, ending: { kind: 'failed', retryable: true, reason } };
    } finally {
      checking.delete(key);
    }
  };

  return {
    start: (attempt: AttemptStart) => {
      const running = runner.start(attempt);
      const stop = new AbortController();
      return {
        ended: running.ended.then((end) => guard(attempt.ref, end, stop.signal)),
        stop: () => {
          stop.abort();
          running.stop();
        },
      };
    },
    progress: (ref) => runner.progress(ref) ?? checking.get(attemptKey.encode(ref)),
  };
}
