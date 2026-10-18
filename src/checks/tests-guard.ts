// The testsUnchanged guard, the shell (ADR 0017, ADR 0078): around the brewer runner, once an
// attempt of a guarded step succeeded, it reads from git what the proven step committed and what
// the attempt changed, and fails the attempt when it changed or removed a test declaration or
// assertion. tests-unchanged.ts decides.

import { type AttemptRef, attemptKey } from '../engine/attempt-key.ts';
import type { AttemptEnd, AttemptStart, BrewerRunner } from '../engine/brewer-runner.ts';
import type { State } from '../engine/fold.ts';
import type { AttemptProgress } from '../engine/supervisor.ts';
import { attemptBranch } from '../workspace/attempt-worktrees.ts';
import type { Git } from '../workspace/git.ts';
import { cut } from './red-proof.ts';
import { readDiff, stepCommits } from './step-commits.ts';
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
  /** Default the system clock. */
  clock?: () => Date;
}

export function guardTests(options: TestsGuardOptions): BrewerRunner {
  const { runner, state, protects, git, clock = () => new Date() } = options;
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
    const current = batch?.steps.get(ref.stepId)?.attempts.get(ref.attempt);
    const worktree = current?.phase === 'scheduled' ? undefined : current?.worktree;
    // Without its own worktree the attempt changed nothing the guard could read.
    if (batch === undefined || worktree === undefined) return end;
    // A step the batch skipped, or that never succeeded, committed no tests to keep.
    const proven = stepCommits(batch, of);
    if (proven === undefined) return end;
    const key = attemptKey.encode(ref);
    checking.set(key, { lastProgressAt: clock(), turnsWithoutProgress: 0 });
    // What the proven step committed, then what this attempt committed on top of where it started.
    const read = async () => {
      const tests = await readDiff(git, worktree.path, proven, { signal });
      if ('error' in tests) return tests;
      // Up to its branch, which the task tree carries on whatever HEAD is (ADR 0066), and only in
      // the files whose lines the guard keeps.
      const own = { from: worktree.commit, to: `refs/heads/${attemptBranch(ref)}` };
      const paths = tests.files.flatMap(({ newPath }) => (newPath === undefined ? [] : [newPath]));
      const changes = await readDiff(git, worktree.path, own, { signal, paths });
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
