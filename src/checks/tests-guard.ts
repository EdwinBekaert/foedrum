// The testsUnchanged guard, the shell (ADR 0017, ADR 0078): around the brewer runner, once an
// attempt of a guarded step succeeded, it reads from git what the proven step committed and what
// the attempt changed, and fails the attempt when it changed or removed a test declaration or
// assertion. tests-unchanged.ts decides.

import { type AttemptRef, attemptKey } from '../engine/attempt-key.ts';
import type { AttemptEnd, AttemptStart, BrewerRunner } from '../engine/brewer-runner.ts';
import type { State } from '../engine/fold.ts';
import { ranIn } from '../engine/session-resume.ts';
import type { AttemptProgress } from '../engine/supervisor.ts';
import { attemptBranch } from '../workspace/attempt-worktrees.ts';
import type { Git } from '../workspace/git.ts';
import { cut } from './red-proof.ts';
import { readDiff, stepCommits } from './step-commits.ts';
import type { ReadTestMapAt } from './test-map.ts';
import { changedTests } from './tests-unchanged.ts';

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
  const { runner, state, protects, git, clone, clock = () => new Date() } = options;
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
    const read = async () => {
      const cwd = clone(worktree.repo);
      const tests = await readDiff(git, cwd, proven, { signal });
      if ('error' in tests) return tests;
      // Up to its branch, which the task tree carries on whatever HEAD is (ADR 0066), and only in
      // the files whose lines the guard keeps.
      const branch = attemptBranch({ ...ref, attempt: ran.attempt });
      const own = { from: worktree.commit, to: `refs/heads/${branch}` };
      const paths = tests.files.flatMap(({ newPath }) => (newPath === undefined ? [] : [newPath]));
      const changes = await readDiff(git, cwd, own, { signal, paths });
      return 'error' in changes ? changes : { tests: tests.files, changes: changes.files };
    };
    try {
      const diffs = await read();
      if (signal.aborted) return { ...end, ending: { kind: 'cancelled' } };
      if ('error' in diffs) {
        const summary = `the guard testsUnchanged cannot read the commits of step ${ref.stepId}: ${diffs.error}`;
        return { ...end, ending: { kind: 'blocked', blockerKind: 'environment', summary } };
      }
      const changed = changedTests(diffs.tests, diffs.changes);
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
