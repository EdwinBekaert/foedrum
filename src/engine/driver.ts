// A driver (ADR 0019): the Cellar or an interactive session. It takes its lock and starts on the
// store before any work (ADR 0037), holds the lease of every batch it drives and renews it on every
// tick (the driver, never the brewer runner), starts the scheduled attempts of those batches on a
// brewer runner, finishes them as they end, runs the supervisor over its own batches and the free
// ones, and applies a batch's effects only while it holds the batch's lease (ADR 0033).

import type {
  AttemptWorktree,
  AttemptWorktrees,
  CleanReport,
} from '../workspace/attempt-worktrees-git.ts';
import { type AttemptRef, attemptKey } from './attempt-key.ts';
import { holdBatch, releaseBatch } from './batch-leases.ts';
import type { AttemptEnd, AttemptLimits, BrewerRunner, RunningAttempt } from './brewer-runner.ts';
import { createCommandLog, defaultReminderMs, defaultRoutingMs } from './command-log.ts';
import type { EngineCommand } from './decide.ts';
import type { DriverLock } from './driver-lock.ts';
import { type DriverStart, startDriver } from './driver-start.ts';
import { effectKey } from './effect-key.ts';
import { applyEffect, type EffectTarget, type Ledger } from './effects.ts';
import type { BatchLease, EffectKey, EventStore, EventStoreTransaction } from './event-store.ts';
import type { State } from './fold.ts';
import type { Recipes } from './recipes.ts';
import type { StateBranch } from './state-branch-git.ts';
import { createSupervisor, type Notice } from './supervisor-loop.ts';
import { batchIsOver, createWorktreeCleanup, endedBatches } from './worktree-cleanup.ts';

/** The effects the driver applies, and where they land. */
export interface DriverEffects {
  /** The effects that the recorded events of `batchId` call for (ADR 0033). */
  due(state: State, batchId: string): EffectKey[];
  target: EffectTarget;
}

/** What the driver reports instead of failing: it keeps driving. */
export type DriverNotice =
  | Notice
  /** Another driver holds a batch this driver held; it starts nothing more there. */
  | { kind: 'batch_lost'; batchId: string; holder: BatchLease }
  /** Applying an effect failed; the batch's other effects wait for the next pass. */
  | { kind: 'effect_failed'; key: EffectKey; error: unknown }
  /** What a cleanup of an ended batch's worktrees did. */
  | { kind: 'cleaned'; batchId: string; report: CleanReport };

export interface DriverOptions {
  store: EventStore;
  runner: BrewerRunner;
  recipes: Recipes;
  clock: () => Date;
  /** Takes the driver's lock: `lockDriver` on the Brewery's work root (ADR 0037). */
  lock: () => DriverLock;
  /**
   * Whether the driver takes a batch that no other driver holds: every one for the Cellar, the
   * batch it brews for an interactive session.
   */
  takes: (batchId: string) => boolean;
  stateBranch: Pick<StateBranch, 'flush'>;
  /** The limits of each step's attempts. */
  limits: (stepId: string) => AttemptLimits;
  /** The attempt worktrees of the one repository the attempts write in, and their base. */
  worktrees?: {
    repo: string;
    base: string;
    manager: Pick<AttemptWorktrees, 'root' | 'create' | 'clean'>;
  };
  effects?: DriverEffects;
  /** How long a batch's or an attempt's lease lasts between renewals; default 5 minutes. */
  leaseMs?: number;
  /** Default 2 days. */
  reminderMs?: number;
  /** Default 1 hour. */
  routingMs?: number;
  report?: (notice: DriverNotice) => void;
}

export interface Driver {
  /** The driver's owner, its lock's: the name its leases carry. */
  readonly owner: string;
  /** What its start did: the leases of its earlier run that expired, and the worktree repair. */
  readonly started: DriverStart;
  /** The batches it holds, by id. */
  held(): string[];
  /** Starts the scheduled attempts of the batches it holds or takes, and finishes the ended ones. */
  drive(): Promise<void>;
  /**
   * Renews its leases, runs a supervisor tick, stops the attempts that Stuck abandoned or whose
   * batch ended, drives on, applies the effects due, and lets go of the batches that are done.
   */
  tick(): Promise<void>;
  /** Applies the effects due of the batches it holds or takes; one pass at a time. */
  applyEffects(): Promise<void>;
  /** The folded state of every committed event. */
  state(): State;
  /** Lets the driver's lock go; its batch leases expire on their own. */
  close(): void;
}

/** The attempt `ref` in `state`, if it was scheduled. */
const attemptOf = (state: State, ref: AttemptRef) =>
  state.batches.get(ref.batchId)?.steps.get(ref.stepId)?.attempts.get(ref.attempt);

/** Whether the log shows `attempt` over: finished, or abandoned by Stuck. */
const isOver = (attempt: ReturnType<typeof attemptOf>): boolean =>
  attempt?.phase === 'finished' || attempt?.abandoned === true;

/**
 * Takes the driver's lock and starts it on the store (`startDriver`), then returns it. Rejects,
 * letting the lock go, when the start fails; nothing is driven before it.
 */
export const openDriver = async (options: DriverOptions): Promise<Driver> => {
  const {
    store,
    runner,
    recipes,
    clock,
    takes,
    stateBranch,
    limits,
    worktrees,
    effects,
    leaseMs = 5 * 60_000,
    reminderMs = defaultReminderMs,
    routingMs = defaultRoutingMs,
    report: reportTo = () => {},
  } = options;
  // A report that throws must not stop the driver.
  const report = (notice: DriverNotice): void => {
    try {
      reportTo(notice);
    } catch {}
  };
  const lock = options.lock();
  const { owner } = lock;
  const log = createCommandLog({ store, recipes, reminderMs, routingMs });
  const cleanup = createWorktreeCleanup({
    worktrees: worktrees === undefined ? [] : [worktrees.manager],
    state: log.state,
    leases: () => store.currentLeases(clock()),
  });
  let started: DriverStart;
  // The batches it holds: at its start, those its owner held before, which it drives on.
  let held: Set<string>;
  try {
    started = await startDriver({ store, lock, now: clock(), cleanup });
    held = new Set(
      store
        .batchLeases(clock())
        .filter((lease) => lease.owner === owner)
        .map((lease) => lease.batchId),
    );
  } catch (error) {
    lock.release();
    throw error;
  }

  // The batches other drivers hold, as of the start of the current tick.
  let others = new Set<string>();
  const supervisor = createSupervisor({
    store,
    stateBranch,
    recipes,
    progress: runner,
    clock,
    reminderMs,
    routingMs,
    report,
    acts: (batchId) => !others.has(batchId),
  });

  const runs = new Map<string, { ref: AttemptRef; run: RunningAttempt }>();
  const ended: { ref: AttemptRef; end: AttemptEnd }[] = [];
  const errors: unknown[] = [];
  // Ended batches whose worktrees drive() cleans next.
  const toClean = new Set<string>();

  const lose = (batchId: string, holder: BatchLease): void => {
    if (held.delete(batchId)) report({ kind: 'batch_lost', batchId, holder });
  };

  /** Whether the driver holds `batchId` now: it renews the lease it holds, or takes a free one. */
  const claim = (batchId: string): boolean => {
    if (!held.has(batchId) && !takes(batchId)) return false;
    const hold = store.withTransaction((tx) =>
      holdBatch(tx, { batchId, owner, now: clock(), leaseMs }),
    );
    if (hold.kind === 'other') {
      lose(batchId, hold.lease);
      return false;
    }
    held.add(batchId);
    return true;
  };

  /** Issues `command` with `also`'s writes; false, reported, when it is refused. */
  const issue = (command: EngineCommand, also?: (tx: EventStoreTransaction) => void): boolean => {
    const decision = log.issue(command, clock(), also);
    if (decision.kind === 'refused') {
      report({ kind: 'refused', command, reason: decision.reason });
      return false;
    }
    return true;
  };

  // The events drive() has looked at for batches that ended, its own and other writers' (a
  // terminal `cancel`): their worktrees are cleaned once (ADR 0037). The start repaired the rest.
  let seenId = store.lastEventId();
  const noteEnded = (): void => {
    const stored = store.eventsAfter(seenId);
    seenId = stored.at(-1)?.id ?? seenId;
    if (worktrees === undefined) return;
    for (const batchId of endedBatches(stored.map(({ event }) => event))) toClean.add(batchId);
  };

  /**
   * The heartbeat: renews the lease of every batch it holds, and of every attempt its runner still
   * runs. At every tick, and before each effect, so a long tick lets none of them expire. Not of an
   * attempt the log shows finished or abandoned: another driver lost it, or Stuck abandoned it, and
   * a new attempt of its step may run beside its run until the next tick stops it (I2).
   */
  const heartbeat = (): void => {
    const now = clock();
    store.withTransaction((tx) => {
      // Read under the write lock: another writer may have lost one of its attempts just before.
      const current = log.state();
      for (const batchId of [...held]) {
        const hold = holdBatch(tx, { batchId, owner, now, leaseMs });
        if (hold.kind === 'other') lose(batchId, hold.lease);
      }
      for (const [key, { ref }] of runs) {
        if (!isOver(attemptOf(current, ref)) && runner.progress(ref) !== undefined) {
          leaseAttempt(tx, key);
        }
      }
    });
  };

  const leaseAttempt = (tx: EventStoreTransaction, key: string): void =>
    tx.putLease({ attemptKey: key, owner, expiresAt: new Date(clock().getTime() + leaseMs) });
  const releaseAttempt = (key: string): void => store.withTransaction((tx) => tx.releaseLease(key));

  /**
   * Records the start of an attempt under its lease, with the worktree it was given; false when it
   * cannot start. An attempt whose worktree cannot be made fails retryably: whatever is in the way
   * stays, and the next attempt has names of its own (ADR 0029).
   */
  const startAttempt = async (ref: AttemptRef, key: string): Promise<boolean> => {
    const started = { type: 'step.started', ...ref } as const;
    if (worktrees === undefined) {
      return issue({ kind: 'record', event: started }, (tx) => leaseAttempt(tx, key));
    }
    // The lease first: only the holder of an attempt's lease may make its worktree.
    store.withTransaction((tx) => leaseAttempt(tx, key));
    let made: AttemptWorktree;
    try {
      made = await worktrees.manager.create(ref, worktrees.base);
    } catch (error) {
      const reason = `the attempt could not get its worktree: ${(error as Error).message}`;
      const ending = { kind: 'failed', retryable: true, reason } as const;
      if (issue({ kind: 'record', event: started })) issue({ kind: 'finish', ...ref, ending });
      releaseAttempt(key);
      return false;
    }
    const worktree = { repo: worktrees.repo, ...made };
    if (issue({ kind: 'record', event: { ...started, worktree } })) return true;
    releaseAttempt(key);
    return false;
  };

  const driveNow = async (): Promise<void> => {
    // A start the guard refuses is tried once per drive: the attempt's deadline covers it.
    const refused = new Set<string>();
    for (;;) {
      let moved = false;
      for (const batch of log.state().batches.values()) {
        if (batch.lane.kind !== 'brewing') continue;
        for (const [stepId, step] of batch.steps) {
          const latest = step.attempts.get(Math.max(...step.attempts.keys()));
          if (latest?.phase !== 'scheduled' || latest.abandoned === true) continue;
          // Another driver's batch, or one this driver does not take, is not its to start.
          if (!claim(batch.id)) continue;
          const ref = { batchId: batch.id, stepId, attempt: latest.attempt };
          const key = attemptKey.encode(ref);
          if (refused.has(key)) continue;
          moved = true;
          if (!(await startAttempt(ref, key))) {
            refused.add(key);
            continue;
          }
          const run = runner.start({ ref, limits: limits(stepId) });
          runs.set(key, { ref, run });
          run.ended.then(
            (end) => ended.push({ ref, end }),
            (error: unknown) => errors.push(error),
          );
        }
      }
      // Let the runs that ended settle their promises.
      await new Promise((resolve) => setImmediate(resolve));
      if (errors.length > 0) throw errors.splice(0)[0];
      for (const { ref, end } of ended.splice(0)) {
        const key = attemptKey.encode(ref);
        runs.delete(key);
        // The step boundary: an attempt that ended is recorded, also in a batch another driver
        // took meanwhile, and lets its lease go, also when Stuck abandoned it and its finish is
        // refused (I2).
        if (!issue({ kind: 'finish', ...ref, ...end }, (tx) => tx.releaseLease(key))) {
          releaseAttempt(key);
        }
        // An attempt of an ended batch held its worktree until now.
        if (worktrees !== undefined && batchIsOver(log.state(), ref.batchId)) {
          toClean.add(ref.batchId);
        }
        moved = true;
      }
      noteEnded();
      for (const batchId of [...toClean]) {
        toClean.delete(batchId);
        report({ kind: 'cleaned', batchId, report: await cleanup.batchEnded(batchId) });
      }
      if (!moved) return;
    }
  };

  // One drive at a time, whoever starts it (a tick or a direct call): two would make an attempt's
  // worktree twice and share the runs and ends they keep.
  let driving: Promise<unknown> = Promise.resolve();
  const drive = (): Promise<void> => {
    const next = driving.then(driveNow);
    driving = next.catch(() => {});
    return next;
  };

  /** The effects of `batchId` due and not in the ledger. */
  const pending = (state: State, batchId: string): EffectKey[] =>
    effects === undefined
      ? []
      : effects.due(state, batchId).filter((key) => store.findEffect(key) === undefined);

  const ledger: Ledger = {
    find: (key) => store.findEffect(key),
    record: (key, result) => {
      const event = { type: 'effect.applied', key: effectKey.encode(key), result } as const;
      const decision = log.issue({ kind: 'record', event }, clock());
      if (decision.kind === 'refused') {
        throw new Error(`The ledger refused ${event.key}: ${decision.reason}`);
      }
    },
  };

  // Each effect under its batch's lease, renewed before it: two drivers never apply one at once,
  // and passes of this driver run one after another (ADR 0033).
  const applyPass = async (): Promise<void> => {
    if (effects === undefined) return;
    const state = log.state();
    for (const batch of state.batches.values()) {
      for (const key of pending(state, batch.id)) {
        heartbeat();
        if (!claim(batch.id)) break;
        try {
          await applyEffect(ledger, key, effects.target);
        } catch (error) {
          report({ kind: 'effect_failed', key, error });
          break;
        }
      }
    }
  };
  let pass: Promise<unknown> = Promise.resolve();
  const applyEffects = (): Promise<void> => {
    const next = pass.then(applyPass);
    pass = next.catch(() => {});
    return next;
  };

  const tick = async (): Promise<void> => {
    const now = clock();
    heartbeat();
    others = new Set(
      store
        .batchLeases(now)
        .filter((lease) => lease.owner !== owner)
        .map((lease) => lease.batchId),
    );
    await supervisor.tick();
    // Stops the processes of attempts that Stuck abandoned (ADR 0027), whose batch ended, or that
    // the log shows finished while this runner still runs them: another driver lost them.
    const current = log.state();
    for (const { ref, run } of runs.values()) {
      const attempt = attemptOf(current, ref);
      if (attempt === undefined) continue;
      if (isOver(attempt) || batchIsOver(current, ref.batchId)) run.stop();
    }
    await drive();
    await applyEffects();
    // A batch that ended, with no attempt running and no effect due, is let go.
    const state = log.state();
    const running = new Set([...runs.values()].map(({ ref }) => ref.batchId));
    const done = [...held].filter(
      (batchId) =>
        batchIsOver(state, batchId) &&
        !running.has(batchId) &&
        pending(state, batchId).length === 0,
    );
    if (done.length > 0) {
      store.withTransaction((tx) => {
        for (const batchId of done) releaseBatch(tx, batchId, owner);
      });
      for (const batchId of done) held.delete(batchId);
    }
  };

  return {
    owner,
    started,
    held: () => [...held].sort(),
    drive,
    tick,
    applyEffects,
    state: log.state,
    close: () => {
      supervisor.stop();
      lock.release();
    },
  };
};
