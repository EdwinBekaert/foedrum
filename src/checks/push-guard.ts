// The noPush guard, the shell (ADR 0106): around the brewer runner, it reads the refs of the target
// repository's remote before an attempt of a guarded step starts and after it ends, and blocks the
// attempt on a divergence when a ref the engine did not write changed. no-push.ts decides.

import { type AttemptRef, attemptKey } from '../engine/attempt-key.ts';
import type {
  AttemptEnd,
  AttemptStart,
  BrewerRunner,
  RunningAttempt,
} from '../engine/brewer-runner.ts';
import type { State } from '../engine/fold.ts';
import type { AttemptProgress } from '../engine/supervisor.ts';
import { changedRefs, noPushReason, parseRemoteRefs, type RemoteRefs } from './no-push.ts';
import type { RemoteWrites } from './remote-writes.ts';

export interface PushGuardOptions {
  runner: BrewerRunner;
  /** The folded state: the driver's, which has recorded the attempt's start and worktree. */
  state: () => State;
  /** Whether the brewer of attempt `ref`'s step has the noPush guard. */
  guarded: (ref: AttemptRef) => boolean;
  /**
   * The refs of `repo`'s remote as `ls-remote --refs` lists them, read outside the clone's
   * configuration (ADR 0096) and with a deadline; rejects when it cannot read them.
   */
  refs: (repo: string, signal: AbortSignal) => Promise<string>;
  /** The engine's own writes to the remotes. */
  writes: RemoteWrites;
  /** Refs the engine writes that guard themselves, such as the state branch (ADR 0024). */
  exempt?: (repo: string, ref: string) => boolean;
  /** Default the system clock. */
  clock?: () => Date;
}

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export function guardPushes(options: PushGuardOptions): BrewerRunner {
  const { runner, state, guarded, refs, writes, exempt = () => false } = options;
  const { clock = () => new Date() } = options;
  // The attempts whose remote it is reading: it reports their progress, so their leases hold.
  const reading = new Map<string, AttemptProgress>();

  /** The remote's refs, or why they cannot be read; progress is reported meanwhile. */
  const read = async (
    key: string,
    repo: string,
    when: 'before' | 'after',
    signal: AbortSignal,
  ): Promise<RemoteRefs | { summary: string }> => {
    reading.set(key, { lastProgressAt: clock(), turnsWithoutProgress: 0 });
    const parsed = await refs(repo, signal).then(parseRemoteRefs, (error: unknown) => ({
      error: messageOf(error),
    }));
    reading.delete(key);
    return 'error' in parsed
      ? {
          summary: `the guard noPush cannot read the refs of the remote of ${repo} ${when} the attempt: ${parsed.error}`,
        }
      : parsed;
  };

  const blocked = (summary: string): AttemptEnd => ({
    ending: { kind: 'blocked', blockerKind: 'environment', summary },
  });

  const guard = (attempt: AttemptStart, repo: string): RunningAttempt => {
    const key = attemptKey.encode(attempt.ref);
    // Stops the read before the brewer starts; the read after runs on its own deadline, so a
    // stopped attempt's push is still found.
    const before = new AbortController();
    let running: RunningAttempt | undefined;
    const ended = (async (): Promise<AttemptEnd> => {
      // Open before the first read, so a write of the engine's that the read sees is in it.
      const window = writes.watch(repo);
      try {
        const start = await read(key, repo, 'before', before.signal);
        if (before.signal.aborted) return { ending: { kind: 'cancelled' } };
        if ('summary' in start) return blocked(start.summary);
        running = runner.start(attempt);
        const end = await running.ended;
        const after = await read(key, repo, 'after', new AbortController().signal);
        if ('summary' in after) return { ...end, ending: blocked(after.summary).ending };
        const engine = window.close();
        const changed = changedRefs(start, after, (ref) => engine.has(ref) || exempt(repo, ref));
        if (changed.length === 0) return end;
        // A push is the engine's alone: the remote is not what the engine left, so the batch is
        // Stuck for a human to look at it, however its recipe routes a failure.
        const summary = noPushReason(repo, changed);
        return { ...end, ending: { kind: 'blocked', blockerKind: 'divergence', summary } };
      } finally {
        window.close();
        reading.delete(key);
      }
    })();
    return {
      ended,
      stop: () => {
        before.abort();
        running?.stop();
      },
    };
  };

  return {
    start: (attempt) => {
      if (!guarded(attempt.ref)) return runner.start(attempt);
      const { batchId, stepId, attempt: number } = attempt.ref;
      const current = state().batches.get(batchId)?.steps.get(stepId)?.attempts.get(number);
      const repo = current?.phase === 'scheduled' ? undefined : current?.worktree?.repo;
      // Without a worktree the attempt cannot run: its plan fails it before anything starts.
      if (repo === undefined) return runner.start(attempt);
      return guard(attempt, repo);
    },
    progress: (ref) => runner.progress(ref) ?? reading.get(attemptKey.encode(ref)),
  };
}
