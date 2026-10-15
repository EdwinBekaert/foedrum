// A minimal driver for engine tests (ADR 0019): it starts every scheduled attempt on a brewer
// runner, keeps the lease of every attempt the runner reports, finishes attempts as they end, and
// runs the supervisor's ticks. Everything goes through decide and an event store, with the clock
// the test controls.

import { type AttemptRef, attemptKey } from '../../src/engine/attempt-key.ts';
import type {
  AttemptEnd,
  AttemptLimits,
  BrewerRunner,
  RunningAttempt,
} from '../../src/engine/brewer-runner.ts';
import { type Command, decide } from '../../src/engine/decide.ts';
import type { EventStore, EventStoreTransaction } from '../../src/engine/event-store.ts';
import { type Batch, emptyState, fold, type State } from '../../src/engine/fold.ts';
import type { Recipes } from '../../src/engine/recipes.ts';
import { createSupervisor, type Notice } from '../../src/engine/supervisor-loop.ts';
import type { Event } from '../../src/schemas/events.ts';
import { OutDocFrontmatter } from '../../src/schemas/out-doc.ts';

export interface BrewingOptions {
  store: EventStore;
  runner: BrewerRunner;
  recipes: Recipes;
  clock: () => Date;
  /** The limits of each step's attempts; default an out doc `out.md` and no limits. */
  limits?: (stepId: string) => AttemptLimits;
  /** How long a lease lasts before the driver renews it; default 5 minutes. */
  leaseMs?: number;
  /** Default 2 days. */
  reminderMs?: number;
}

export const defaultLimits: AttemptLimits = {
  outDoc: { file: 'out.md', schema: OutDocFrontmatter },
};

export const createBrewing = (options: BrewingOptions) => {
  const {
    store,
    runner,
    recipes,
    clock,
    limits = () => defaultLimits,
    leaseMs = 5 * 60_000,
    reminderMs = 2 * 24 * 3_600_000,
  } = options;
  const refusals: string[] = [];
  const notices: Notice[] = [];
  const runs = new Map<string, { ref: AttemptRef; run: RunningAttempt }>();
  const ended: { ref: AttemptRef; end: AttemptEnd }[] = [];
  const errors: unknown[] = [];
  const supervisor = createSupervisor({
    store,
    stateBranch: { flush: async () => ({ kind: 'unchanged' }) },
    recipes,
    progress: runner,
    clock,
    timer: { set: () => 0, clear: () => {} },
    reminderMs,
    report: (notice) => notices.push(notice),
  });

  const events = (): Event[] => store.eventsAfter(0).map(({ event }) => event);
  // The folded state, kept up to date with whatever was appended since it was last read.
  let folded = { state: emptyState, lastId: 0 };
  const state = (): State => {
    const stored = store.eventsAfter(folded.lastId);
    folded = {
      state: fold(
        stored.map(({ event }) => event),
        folded.state,
      ),
      lastId: stored.at(-1)?.id ?? folded.lastId,
    };
    return folded.state;
  };

  /** Decides `command` and appends its events with `also`'s writes; false when it is refused. */
  const command = (cmd: Command, also: (tx: EventStoreTransaction) => void = () => {}) => {
    const decision = decide(state(), cmd, { now: clock(), recipes, reminderMs });
    if (decision.kind === 'refused') {
      refusals.push(decision.reason);
      return false;
    }
    store.withTransaction((tx) => {
      for (const event of decision.events) tx.append(event);
      also(tx);
    });
    return true;
  };

  const lease = (tx: EventStoreTransaction, key: string): void =>
    tx.putLease({
      attemptKey: key,
      owner: 'driver-1',
      expiresAt: new Date(clock().getTime() + leaseMs),
    });

  /** Starts the scheduled attempts and finishes the ended ones until nothing moves. */
  const drive = async (): Promise<void> => {
    for (;;) {
      let moved = false;
      for (const batch of state().batches.values()) {
        if (batch.lane.kind !== 'brewing') continue;
        for (const [stepId, step] of batch.steps) {
          const latest = step.attempts.get(Math.max(...step.attempts.keys()));
          if (latest?.phase !== 'scheduled' || latest.abandoned === true) continue;
          const ref = { batchId: batch.id, stepId, attempt: latest.attempt };
          const key = attemptKey.encode(ref);
          command({ kind: 'record', event: { type: 'step.started', ...ref } }, (tx) =>
            lease(tx, key),
          );
          const run = runner.start({ ref, limits: limits(stepId) });
          runs.set(key, { ref, run });
          run.ended.then(
            (end) => ended.push({ ref, end }),
            (error: unknown) => errors.push(error),
          );
          moved = true;
        }
      }
      // Let the runs that ended settle their promises.
      await new Promise((resolve) => setImmediate(resolve));
      if (errors.length > 0) throw errors[0];
      for (const { ref, end } of ended.splice(0)) {
        const key = attemptKey.encode(ref);
        runs.delete(key);
        // An attempt that ended holds its worktree no longer, also when Stuck abandoned it and
        // its finish is refused: the next attempt of its step may resume in that worktree (I2).
        if (!command({ kind: 'finish', ...ref, ...end }, (tx) => tx.releaseLease(key))) {
          store.withTransaction((tx) => tx.releaseLease(key));
        }
        moved = true;
      }
      if (!moved) return;
    }
  };

  /**
   * Renews the leases of the attempts the runner reports, runs a supervisor tick, stops the
   * processes of attempts that Stuck abandoned (ADR 0027), and drives on.
   */
  const tick = async (): Promise<void> => {
    store.withTransaction((tx) => {
      for (const [key, { ref }] of runs) {
        if (runner.progress(ref) !== undefined) lease(tx, key);
      }
    });
    await supervisor.tick();
    const current = state();
    for (const { ref, run } of runs.values()) {
      const attempt = current.batches
        .get(ref.batchId)
        ?.steps.get(ref.stepId)
        ?.attempts.get(ref.attempt);
      if (attempt !== undefined && attempt.phase !== 'finished' && attempt.abandoned === true) {
        run.stop();
      }
    }
    await drive();
  };

  const batch = (batchId: string): Batch => {
    const found = state().batches.get(batchId);
    if (found === undefined) throw new Error(`No batch ${batchId}`);
    return found;
  };

  return { command, drive, tick, events, state, batch, refusals, notices };
};
