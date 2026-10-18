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
import { defaultLeaseMs, holdBatch, releaseBatch } from './batch-leases.ts';
import type { AttemptEnd, AttemptLimits, BrewerRunner, RunningAttempt } from './brewer-runner.ts';
import { createCommandLog, defaultReminderMs, defaultRoutingMs } from './command-log.ts';
import type { Ending, EngineCommand } from './decide.ts';
import type { DriverLock } from './driver-lock.ts';
import { type DriverStart, startDriver } from './driver-start.ts';
import { effectKey } from './effect-key.ts';
import { applyEffect, type EffectTarget, type Ledger } from './effects.ts';
import type { BatchLease, EffectKey, EventStore, EventStoreTransaction } from './event-store.ts';
import type { State } from './fold.ts';
import type { RecipeAction, Recipes } from './recipes.ts';
import type { StateBranch } from './state-branch-git.ts';
import { createSupervisor, type Notice } from './supervisor-loop.ts';
import { sameRepo, taskTreeStart } from './task-tree.ts';
import { batchIsOver, createWorktreeCleanup, endedBatches } from './worktree-cleanup.ts';

/** The effects the driver applies, and where they land. */
export interface DriverEffects {
  /** The effects that the recorded events of `batchId` call for (ADR 0033). */
  due(state: State, batchId: string): EffectKey[];
  target: EffectTarget;
  /**
   * How long one effect may take before the driver gives it up and aborts it: whole milliseconds
   * below `leaseMs`, half of it by default. The lease is renewed before each effect, not during
   * one, so a slower effect could let a second driver start it too (ADR 0044, #130).
   */
  deadlineMs?: number;
}

/**
 * The actions the engine runs itself, never a brewer (ADR 0071): an attempt of an action step is
 * started by the driver, applies its effects through the ledger, and ends once none is left.
 */
export interface DriverActions {
  /** The effects the started action attempt `ref` calls for, in the order they apply. */
  due(state: State, ref: AttemptRef): EffectKey[];
  target: EffectTarget;
  /** How `ref` ends, once every effect it called for is in the ledger. */
  ending(state: State, ref: AttemptRef): Ending;
}

/**
 * The attempt worktrees of a repository the attempts write in, and the base a batch starts at
 * until its task tree moves (ADR 0066).
 */
export interface RepositoryWorktrees {
  repo: string;
  base: string;
  manager: Pick<AttemptWorktrees, 'root' | 'create' | 'clean'>;
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
  /** The limits of an attempt: its brewer's, from the recipe its batch brews. */
  limits: (attempt: AttemptRef) => AttemptLimits;
  /** The attempt worktrees of each repository the attempts write in, and their base. */
  worktrees?: readonly RepositoryWorktrees[];
  /** What else goes with an ended batch's worktrees: its attempt settings (ADR 0063). */
  alsoCleans?: readonly Pick<AttemptWorktrees, 'root' | 'clean'>[];
  effects?: DriverEffects;
  /**
   * The actions it runs itself (ADR 0071). Without them, an attempt of an action step is blocked
   * on its environment at its start.
   */
  actions?: DriverActions;
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
  /** Stops the runs it still has and lets its lock go; its batch leases expire on their own. */
  close(): void;
}

/**
 * The repository an attempt of `batchId` writes in (ADR 0063): a claimed issue's, a sub-order's,
 * or the only one of the Brewery for a Brewery order. Throws with the reason when there is none.
 */
export const repositoryOf = <R extends { readonly repo: string }>(
  state: State,
  batchId: string,
  repositories: readonly R[],
): R => {
  const batch = state.batches.get(batchId);
  // A Brewery issue that is a sub-order writes in its repository, with a parent batch or not.
  const repo =
    batch?.repo ?? (batch === undefined ? undefined : state.subOrders.get(batch.issue)?.repo);
  if (repo === undefined) {
    const [only] = repositories;
    if (only !== undefined && repositories.length === 1) return only;
    throw new Error(
      `batch ${batchId} names no repository, and the Brewery has ${repositories.length}`,
    );
  }
  const found = repositories.find((each) => sameRepo(each.repo, repo));
  if (found === undefined) {
    throw new Error(`batch ${batchId} writes in ${repo}, which the Brewery does not list`);
  }
  return found;
};

/** The attempt `ref` in `state`, if it was scheduled. */
const attemptOf = (state: State, ref: AttemptRef) =>
  state.batches.get(ref.batchId)?.steps.get(ref.stepId)?.attempts.get(ref.attempt);

/** Whether the log shows `attempt` over: finished, or abandoned by Stuck. */
const isOver = (attempt: ReturnType<typeof attemptOf>): boolean =>
  attempt?.phase === 'finished' || attempt?.abandoned === true;

/** The action `ref`'s step is in its batch's recipe, or `undefined` for any other step. */
const actionOf = (state: State, recipes: Recipes, ref: AttemptRef) => {
  const name = state.batches.get(ref.batchId)?.recipe?.name;
  const recipe = name === undefined ? undefined : recipes.find(name);
  return recipe?.has(ref.stepId) === true ? recipe.action(ref.stepId) : undefined;
};

/**
 * The action attempts of `batchId` that run: started, the latest of their step, not abandoned,
 * in a brewing batch (ADR 0071).
 */
const runningActions = (state: State, recipes: Recipes, batchId: string): AttemptRef[] => {
  const batch = state.batches.get(batchId);
  if (batch?.lane.kind !== 'brewing') return [];
  return [...batch.steps.values()].flatMap((step) => {
    const latest = step.attempts.get(Math.max(...step.attempts.keys()));
    if (latest?.phase !== 'started' || latest.abandoned === true) return [];
    const ref = { batchId, stepId: step.id, attempt: latest.attempt };
    return actionOf(state, recipes, ref) === undefined ? [] : [ref];
  });
};

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
    worktrees = [],
    alsoCleans = [],
    effects,
    actions,
    leaseMs = defaultLeaseMs,
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
  const deadlineMs = effects?.deadlineMs ?? Math.floor(leaseMs / 2);
  const lock = options.lock();
  const { owner } = lock;
  const log = createCommandLog({ store, recipes, reminderMs, routingMs });
  // What the worktree cleanup goes over: each repository's worktrees, and what goes with them.
  const cleaners = [...worktrees.map(({ manager }) => manager), ...alsoCleans];
  const cleanup = createWorktreeCleanup({
    worktrees: cleaners,
    state: log.state,
    leases: () => store.currentLeases(clock()),
  });
  let started: DriverStart;
  // The batches it holds: at its start, those its owner held before, which it drives on.
  let held: Set<string>;
  try {
    if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 1 || deadlineMs >= leaseMs) {
      throw new RangeError(
        `The deadline of an effect must be a whole number of milliseconds below the lease of ${leaseMs} ms, got ${deadlineMs}`,
      );
    }
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
  // Ended batches cleaned while an attempt of theirs held a live lease, which kept its worktree:
  // cleaned again once no lease of theirs is alive. A run that ends lets its lease go, but one
  // whose process died with the runner never ends, and its lease only expires (ADR 0037, ADR 0061).
  const cleanedLeased = new Set<string>();
  const leasedBatches = (): Set<string> =>
    new Set(
      store
        .currentLeases(clock())
        .flatMap((lease) => attemptKey.decode(lease.attemptKey)?.batchId ?? []),
    );

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
    if (cleaners.length === 0) return;
    for (const batchId of endedBatches(stored.map(({ event }) => event))) toClean.add(batchId);
  };

  /**
   * The heartbeat: renews the lease of every batch it holds, and of every attempt its runner still
   * runs. At every tick, and before each effect, so a long tick lets none of them expire. Not of an
   * attempt the log shows finished or abandoned: another driver lost it, or Stuck abandoned it, and
   * so its lease lapses and the next attempt of its step can start (I2).
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
    if (worktrees.length === 0) {
      return issue({ kind: 'record', event: started }, (tx) => leaseAttempt(tx, key));
    }
    // The lease first: only the holder of an attempt's lease may make its worktree.
    store.withTransaction((tx) => leaseAttempt(tx, key));
    let repository: RepositoryWorktrees;
    let made: AttemptWorktree;
    try {
      const state = log.state();
      repository = repositoryOf(state, ref.batchId, worktrees);
      const batch = state.batches.get(ref.batchId);
      if (batch === undefined) throw new Error(`no batch ${ref.batchId}`);
      // At the commits of the steps before it (ADR 0066).
      made = await repository.manager.create(ref, taskTreeStart(batch, repository));
    } catch (error) {
      const reason = `the attempt could not get its worktree: ${(error as Error).message}`;
      const ending = { kind: 'failed', retryable: true, reason } as const;
      if (issue({ kind: 'record', event: started })) issue({ kind: 'finish', ...ref, ending });
      releaseAttempt(key);
      return false;
    }
    const worktree = { repo: repository.repo, ...made };
    if (issue({ kind: 'record', event: { ...started, worktree } })) return true;
    releaseAttempt(key);
    return false;
  };

  /**
   * Whether another attempt of `ref`'s step holds one of the live `leases`: one Stuck abandoned,
   * whose stopped run has not ended. `ref` starts once that lease is released or expired, which
   * the heartbeat no longer renews, and never beside it (I2, #150). The wait lasts one lease at
   * most, and `ref`'s deadline runs through it: a step whose deadline is shorter than what is left
   * of that lease goes Stuck with its deadline passed before `ref` started, as a step does whose
   * deadline passes while no driver runs. That is intended: the step could not start in time.
   */
  /**
   * Records the start of an action attempt, which the driver runs itself through its effects
   * (ADR 0071): no lease, since no process runs it and the holder of the batch's lease applies the
   * effects, and no worktree, since the push reads the task tree in the clone (ADR 0066). Without
   * actions to run it, the attempt is blocked on its environment at once.
   */
  const startAction = (ref: AttemptRef, action: RecipeAction): boolean => {
    if (!issue({ kind: 'record', event: { type: 'step.started', ...ref } })) return false;
    if (actions === undefined) {
      const summary = `the driver has no code host to run the ${action} action of step ${ref.stepId} on`;
      issue({
        kind: 'finish',
        ...ref,
        ending: { kind: 'blocked', blockerKind: 'environment', summary },
      });
    }
    return true;
  };

  const stepLeased = (leases: readonly AttemptRef[], ref: AttemptRef): boolean =>
    leases.some(
      (other) =>
        other.batchId === ref.batchId &&
        other.stepId === ref.stepId &&
        other.attempt !== ref.attempt,
    );

  const driveNow = async (): Promise<void> => {
    // A start the guard refuses is tried once per drive: the attempt's deadline covers it.
    const refused = new Set<string>();
    for (;;) {
      let moved = false;
      // Once per pass: a run that ended in the pass before let its lease go.
      const leases = store
        .currentLeases(clock())
        .flatMap((lease) => attemptKey.decode(lease.attemptKey) ?? []);
      for (const batch of log.state().batches.values()) {
        if (batch.lane.kind !== 'brewing') continue;
        for (const [stepId, step] of batch.steps) {
          const latest = step.attempts.get(Math.max(...step.attempts.keys()));
          if (latest?.phase !== 'scheduled' || latest.abandoned === true) continue;
          // Another driver's batch, or one this driver does not take, is not its to start.
          if (!claim(batch.id)) continue;
          const ref = { batchId: batch.id, stepId, attempt: latest.attempt };
          const key = attemptKey.encode(ref);
          if (refused.has(key) || stepLeased(leases, ref)) continue;
          moved = true;
          const action = actionOf(log.state(), recipes, ref);
          if (action !== undefined) {
            if (!startAction(ref, action)) refused.add(key);
            continue;
          }
          if (!(await startAttempt(ref, key))) {
            refused.add(key);
            continue;
          }
          const run = runner.start({ ref, limits: limits(ref) });
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
        if (cleaners.length > 0 && batchIsOver(log.state(), ref.batchId)) {
          toClean.add(ref.batchId);
        }
        moved = true;
      }
      noteEnded();
      if (cleanedLeased.size > 0) {
        const leased = leasedBatches();
        for (const batchId of [...cleanedLeased]) {
          if (leased.has(batchId)) continue;
          cleanedLeased.delete(batchId);
          toClean.add(batchId);
        }
      }
      for (const batchId of [...toClean]) {
        toClean.delete(batchId);
        // Asked before the cleanup reads its claims: a lease it keeps a worktree for may expire
        // while its git steps run. An ended batch gets no new lease, so asking early misses none.
        if (leasedBatches().has(batchId)) cleanedLeased.add(batchId);
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

  /** The effects of `batchId` due and not in the ledger, its actions' after the others, with their target. */
  const pending = (state: State, batchId: string): { key: EffectKey; target: EffectTarget }[] => {
    const due = [
      ...(effects === undefined
        ? []
        : effects.due(state, batchId).map((key) => ({ key, target: effects.target }))),
      ...(actions === undefined
        ? []
        : runningActions(state, recipes, batchId).flatMap((ref) =>
            actions.due(state, ref).map((key) => ({ key, target: actions.target })),
          )),
    ];
    return due.filter(({ key }) => store.findEffect(key) === undefined);
  };

  /**
   * Ends the running action attempts of `batchId` whose effects are all in the ledger: the step
   * boundary, under the batch's lease. A driver killed after the last effect and before the end
   * leaves it to the next pass of whichever driver holds the batch (ADR 0071).
   */
  const finishActions = (batchId: string): void => {
    if (actions === undefined) return;
    const state = log.state();
    for (const ref of runningActions(state, recipes, batchId)) {
      if (actions.due(state, ref).some((key) => store.findEffect(key) === undefined)) continue;
      if (!claim(batchId)) return;
      issue({ kind: 'finish', ...ref, ending: actions.ending(state, ref) });
    }
  };

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

  /** Runs `work` until `deadlineMs`, then aborts its signal and rejects, whether it stops or not. */
  const withinDeadline = async <T>(
    key: EffectKey,
    work: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> => {
    const controller = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        const error = new Error(
          `The effect ${effectKey.encode(key)} took longer than its deadline of ${deadlineMs} ms`,
        );
        controller.abort(error);
        reject(error);
      }, deadlineMs);
    });
    const working = work(controller.signal);
    // What it does after the deadline is no longer awaited: never an unhandled rejection.
    working.catch(() => {});
    try {
      return await Promise.race([working, late]);
    } finally {
      clearTimeout(timer);
    }
  };

  // Each effect under its batch's lease, renewed before it: two drivers never apply one at once,
  // and passes of this driver run one after another (ADR 0033).
  const applyPass = async (): Promise<void> => {
    if (effects === undefined && actions === undefined) return;
    const state = log.state();
    for (const batch of state.batches.values()) {
      let stopped = false;
      for (const { key, target } of pending(state, batch.id)) {
        heartbeat();
        if (!claim(batch.id)) {
          stopped = true;
          break;
        }
        try {
          await withinDeadline(key, (signal) => applyEffect(ledger, key, target, signal));
        } catch (error) {
          report({ kind: 'effect_failed', key, error });
          stopped = true;
          break;
        }
      }
      if (!stopped) finishActions(batch.id);
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
      // Their ends are not recorded: the next start of this owner loses them (ADR 0033, ADR 0063).
      for (const { run } of runs.values()) run.stop();
      supervisor.stop();
      lock.release();
    },
  };
};
