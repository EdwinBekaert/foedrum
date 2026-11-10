// A driver (ADR 0019): the Cellar or an interactive session. It takes its lock and starts on the
// store before any work (ADR 0037), holds the lease of every batch it drives and renews it on every
// tick (the driver, never the brewer runner), starts the scheduled attempts of those batches on a
// brewer runner, finishes them as they end, runs the supervisor over its own batches and the free
// ones, and applies a batch's effects only while it holds the batch's lease (ADR 0033).

import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import { firstLineOf, messageOf } from '../platform/errors.ts';
import {
  type CheckoutRef,
  ClaudeReport,
  type FailingPass,
  Receipt,
  type SessionRef,
} from '../schemas/events.ts';
import { checkoutName, type Target } from '../workspace/attempt-worktrees.ts';
import type {
  AttemptWorktree,
  AttemptWorktrees,
  CleanReport,
} from '../workspace/attempt-worktrees-git.ts';
import { type AttemptRef, attemptKey } from './attempt-key.ts';
import {
  type BaseMerge,
  baseMergeKey,
  baseMergeTarget,
  mergeEnding,
  routedMerge,
  startMergeOf,
  unconcludedMerge,
} from './base-merge.ts';
import { defaultLeaseMs, holdBatch, releaseBatch } from './batch-leases.ts';
import type { AttemptEnd, AttemptLimits, BrewerRunner, RunningAttempt } from './brewer-runner.ts';
import { createCommandLog, defaultReminderMs, defaultRoutingMs } from './command-log.ts';
import { type Ending, type EngineCommand, failingStep, type RecordedEvent } from './decide.ts';
import type { DriverLock } from './driver-lock.ts';
import { type DriverStart, startDriver } from './driver-start.ts';
import { effectKey } from './effect-key.ts';
import { applyEffect, type EffectTarget, type Ledger, UnreadSources } from './effects.ts';
import type { BatchLease, EffectKey, EventStore, EventStoreTransaction } from './event-store.ts';
import { createFailingBatches } from './failing-batches.ts';
import { createFailureLines } from './failure-lines.ts';
import { attemptRecipeOf, type Batch, runningAttempt, type State, stuckOnFailing } from './fold.ts';
import type { OrderCheck } from './order-changes.ts';
import { withoutSecrets } from './out-doc-text.ts';
import { pauseOf, stopsNow } from './pauses.ts';
import type { RecipeAction, Recipes } from './recipes.ts';
import { afterOverrun, type Resumption, resumeOf } from './session-resume.ts';
import type { StateBranch } from './state-branch-git.ts';
import type { AttemptProgress } from './supervisor.ts';
import { createSupervisor, type FailurePass, type Notice } from './supervisor-loop.ts';
import { attemptStart, sameRepo } from './task-tree.ts';
import { type ModelFamily, type Reopen, reopenOf, windowHolds } from './usage-window.ts';
import type { OutDocOf } from './worktree-claims.ts';
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
  /**
   * The events to record once every effect `due` gives for `batchId` is in the ledger, which the
   * driver records under the batch's lease after the pass (ADR 0285); none by default.
   */
  recorded?(state: State, batchId: string): RecordedEvent[];
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
 * until its task tree moves (ADR 0066). A manager without `recreate` resumes no session: its
 * retries start fresh (ADR 0117).
 */
export interface RepositoryWorktrees {
  repo: string;
  base: string;
  /** Its alias, which names its checkout in a Brewery order's folder (ADR 0301). */
  alias?: string;
  manager: Pick<AttemptWorktrees, 'root' | 'create' | 'clean'> &
    Partial<Pick<AttemptWorktrees, 'recreate' | 'checkout'>>;
  /**
   * How an attempt of a step that merges the base merges it before it runs (ADR 0164); without
   * it, nothing is merged.
   */
  merge?: BaseMerge;
}

/** What the driver reports instead of failing: it keeps driving. */
export type DriverNotice =
  | Notice
  /** Another driver holds a batch this driver held; it starts nothing more there. */
  | { kind: 'batch_lost'; batchId: string; holder: BatchLease }
  /** Applying an effect failed; the batch's other effects wait for the next pass. */
  | { kind: 'effect_failed'; key: EffectKey; error: unknown }
  /**
   * A pass over a batch's effects threw, reading them or finishing what they call for, outside any
   * one effect: what the pass already recorded stays, the next pass goes on from there, and the
   * others go on (ADR 0327).
   */
  | { kind: 'batch_effects_failed'; batchId: string; error: unknown }
  /** A pass that a batch failed in, said once, went over it clean (ADR 0328). */
  | { kind: 'batch_recovered'; batchId: string; pass: FailurePass | 'effects' }
  /**
   * The runner's end of an attempt rejected: the attempt is blocked on its environment, and the
   * other runs go on (ADR 0099).
   */
  | { kind: 'run_failed'; ref: AttemptRef; error: unknown }
  /**
   * `ref` is scheduled but waits until `waitsFor`, another attempt of its step, lets go of its live
   * lease, which expires at `expiresAt` unless renewed (ADR 0055); said once per attempt (#155).
   */
  | { kind: 'waiting_for_lease'; ref: AttemptRef; waitsFor: AttemptRef; expiresAt: Date }
  /** What a cleanup of an ended batch's worktrees did. */
  | { kind: 'cleaned'; batchId: string; report: CleanReport };

/** What the driver spends time on that a person waits for: an effect it applies, a batch's cleanup. */
export type Doing = { kind: 'effect'; key: EffectKey } | { kind: 'clean' };

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
  /**
   * The out doc of an attempt's brewer, in the recipe it was scheduled under, which the worktree
   * cleanup lets go (ADR 0081, ADR 0260).
   */
  outDoc?: OutDocOf;
  /** The attempt worktrees of each repository the attempts write in, and their base. */
  worktrees?: readonly RepositoryWorktrees[];
  /**
   * Whether an attempt runs a brewer, in a Claude Code session the driver chooses and records with
   * its worktree (ADR 0116): every attempt with a worktree by default; `serve` leaves out its
   * check steps.
   */
  brews?: (attempt: AttemptRef) => boolean;
  /**
   * Whether the brewer of an attempt only reads (`access: "read"`): such an attempt of a Brewery
   * order in a Brewery of several repositories gets a checkout of each (ADR 0301), and any other
   * attempt of such an order fails. None reads by default.
   */
  reads?: (attempt: AttemptRef) => boolean;
  /**
   * Whether the brewer of an attempt resumes the session of the attempt before it on a retry or an
   * answer (`retryMode: resume`, ADR 0117, ADR 0118); never by default. `foedrum serve` and
   * `foedrum brew` ask the brewer of the attempt's step.
   */
  resumes?: (attempt: AttemptRef) => boolean;
  /**
   * The model family a brewer attempt runs on, to know which closed usage window holds it
   * (ADR 0215); undefined, which every closed window holds, by default.
   */
  family?: (attempt: AttemptRef) => ModelFamily | undefined;
  /**
   * The IANA time zone claude's usage-limit reset is read in (ADR 0206); default the machine's.
   */
  zone?: () => string;
  /** The id of a new session; default `randomUUID`. */
  sessionId?: () => string;
  /**
   * Which of the batches its owner held at its start it drives on (ADR 0044): every one by
   * default. An interactive driver keeps none, so a batch it left earlier lapses within a lease
   * instead of being driven beside the one it brews (ADR 0123); it holds that one through `takes`.
   */
  drivesOn?: (batchId: string) => boolean;
  /**
   * Whether it goes on with a batch it may hold: claims it, starts its attempts and applies its
   * effects. Every batch by default; `foedrum resume` of a running batch lets its batch be once
   * the attempt that continues the session has ended, for the driver that takes it next (ADR 0127).
   */
  holds?: (batchId: string) => boolean;
  /**
   * Whether it opens an interactive step's session (ADR 0222): `foedrum brew` on a terminal. A
   * driver that opens none, by default, parks such a step's attempt Stuck, waiting for a session.
   */
  sessions?: boolean;
  /** What else goes with an ended batch's worktrees: its attempt settings (ADR 0063). */
  alsoCleans?: readonly Pick<AttemptWorktrees, 'root' | 'clean'>[];
  effects?: DriverEffects;
  /**
   * The actions it runs itself (ADR 0071). Without them, an attempt of an action step is blocked
   * on its environment at its start.
   */
  actions?: DriverActions;
  /**
   * What changed on a claimed order's issue since it was approved, read before each of its attempts
   * that reads the issue starts, a brewer's or an action's, never a check step's (ADR 0368);
   * without it, nothing is read and no attempt asks.
   */
  orderCheck?: OrderCheck;
  /** How long a batch's or an attempt's lease lasts between renewals; default 5 minutes. */
  leaseMs?: number;
  /** Default 2 days. */
  reminderMs?: number;
  /** Default 1 hour. */
  routingMs?: number;
  report?: (notice: DriverNotice) => void;
  /** Told what the driver is about to spend time on, before it starts, for a live line to name (ADR 0346). */
  doing?: (what: Doing) => void;
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
  /** What the runner reports of the running attempt `ref`, for display (ADR 0174). */
  progress(ref: AttemptRef): AttemptProgress | undefined;
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
  const repo = ownRepoOf(state, batchId);
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

/**
 * The repository of `batchId`'s own: a claimed issue's or a sub-order's; undefined for a Brewery
 * order, which has none (ADR 0063, ADR 0301).
 */
const ownRepoOf = (state: State, batchId: string): string | undefined => {
  const batch = state.batches.get(batchId);
  // A Brewery issue that is a sub-order writes in its repository, with a parent batch or not.
  return batch?.repo ?? (batch === undefined ? undefined : state.subOrders.get(batch.issue)?.repo);
};

/** How much of a rejected run's message its summary keeps: the runner may quote what it read. */
const summaryLength = 120;

/** The message of whatever was thrown; empty when it cannot be read. */
const rejectionText = (error: unknown): string => {
  try {
    return messageOf(error);
  } catch {
    return '';
  }
};

/**
 * The summary of a run whose end rejected with `error` (ADR 0099): the first line of its message,
 * at most `summaryLength` characters, or a fixed text when that has nothing to show or cannot be
 * read, since the event store refuses an empty summary.
 */
const rejectionSummary = (error: unknown): string => {
  const line = firstLineOf(rejectionText(error)).trim().slice(0, summaryLength);
  return line === '' ? 'the brewer runner failed without a message' : line;
};

/**
 * The summary of a batch's failure (ADR 0335), which its status comment shows: the first line, read
 * for a secret before it is cut, so a secret the cut would break in two is not recorded in part.
 */
const failingSummary = (error: unknown): string => {
  const line = firstLineOf(rejectionText(error)).trim();
  if (line === '') return 'the batch failed without a message';
  return withoutSecrets(line, '', () => false) === line
    ? line.slice(0, summaryLength)
    : 'the failure reads like a secret, so its text is left out';
};

/**
 * The command that records how `ref` ended. The session id stays on its step.started; what claude
 * reported in its init goes on its step.finished, when the event can hold it: a blank version or
 * model is left out rather than refusing the ending with it (ADR 0116).
 */
const finishOf = (
  ref: AttemptRef,
  end: AttemptEnd,
  paused: boolean,
  reopensAt: Reopen | undefined,
): EngineCommand => {
  const { session, receipt, ...rest } = end;
  const report = ClaudeReport.safeParse({ version: session?.claudeVersion, model: session?.model });
  // Read from a stream the runner does not trust: one the event cannot hold is left out (ADR 0172).
  const took = Receipt.safeParse(receipt);
  return {
    kind: 'finish',
    ...ref,
    ...rest,
    ...(report.success ? { claude: report.data } : {}),
    ...(took.success ? { receipt: took.data } : {}),
    // Stopped as its batch's pause reached its stopAt: no retry is spent on it (ADR 0202).
    ...(paused && end.ending.kind === 'cancelled' ? { paused: true as const } : {}),
    // Its usage window reopens at the reset claude named, read in the machine's zone (ADR 0206).
    ...(reopensAt === undefined ? {} : { reopensAt }),
  };
};

/** A live lease of an attempt, whose it is, and when it expires unless it is renewed. */
interface AttemptLease {
  ref: AttemptRef;
  owner: string;
  expiresAt: Date;
}

/** The attempt `ref` in `state`, if it was scheduled. */
const attemptOf = (state: State, ref: AttemptRef) =>
  state.batches.get(ref.batchId)?.steps.get(ref.stepId)?.attempts.get(ref.attempt);

/** Whether the log shows `attempt` over: finished, or abandoned by Stuck. */
const isOver = (attempt: ReturnType<typeof attemptOf>): boolean =>
  attempt?.phase === 'finished' || attempt?.abandoned === true;

/** The recipe of `ref`'s batch, when it has `ref`'s step. */
const recipeWith = (state: State, recipes: Recipes, ref: AttemptRef) => {
  const name = state.batches.get(ref.batchId)?.recipe?.name;
  const recipe = name === undefined ? undefined : recipes.find(name);
  return recipe?.has(ref.stepId) === true ? recipe : undefined;
};

/** Whether `ref` is an attempt of an interactive step, a person's session (ADR 0222). */
const interactiveOf = (state: State, recipes: Recipes, ref: AttemptRef): boolean =>
  recipeWith(state, recipes, ref)?.interactive(ref.stepId) === true;

/** The action `ref`'s step is in its batch's recipe, or `undefined` for any other step. */
const actionOf = (state: State, recipes: Recipes, ref: AttemptRef) =>
  recipeWith(state, recipes, ref)?.action(ref.stepId);

/**
 * The action attempts of `batchId` that run: started, the latest of their step, not abandoned,
 * in a brewing batch (ADR 0071).
 */
const runningActions = (state: State, recipes: Recipes, batchId: string): AttemptRef[] => {
  const batch = state.batches.get(batchId);
  if (batch?.lane.kind !== 'brewing') return [];
  return [...batch.steps.values()].flatMap((step) => {
    const latest = runningAttempt(step);
    if (latest?.phase !== 'started') return [];
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
    outDoc,
    worktrees = [],
    brews = () => true,
    family = () => undefined,
    resumes = () => false,
    reads = () => false,
    zone = () => Intl.DateTimeFormat().resolvedOptions().timeZone,
    sessionId = randomUUID,
    drivesOn = () => true,
    holds = () => true,
    sessions = false,
    alsoCleans = [],
    effects,
    orderCheck,
    actions,
    leaseMs = defaultLeaseMs,
    reminderMs = defaultReminderMs,
    routingMs = defaultRoutingMs,
    report: reportTo = () => {},
    doing: doingTo = () => {},
  } = options;
  // A report that throws must not stop the driver.
  const report = (notice: DriverNotice): void => {
    try {
      reportTo(notice);
    } catch {}
  };
  // Nor does what it tells a live line: it is for display (ADR 0346).
  const doing = (what: Doing): void => {
    try {
      doingTo(what);
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
    ...(outDoc === undefined ? {} : { outDoc }),
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
        .filter((lease) => lease.owner === owner && drivesOn(lease.batchId))
        .map((lease) => lease.batchId),
    );
  } catch (error) {
    lock.release();
    throw error;
  }

  // What it said of the batches that threw, so a batch that keeps throwing is one line (ADR 0328).
  const failureLines = createFailureLines();
  // Since when its passes fail on each batch, which marks a batch after an hour (ADR 0335).
  const failing = createFailingBatches();
  const noteFailing = (
    batchId: string,
    pass: FailingPass,
    error: unknown,
    reading: boolean,
  ): void => failing.failed(batchId, pass, failingSummary(error), reading, clock());
  /** Says a batch's failure, unless it said that one last in that pass. */
  const sayFailure = (
    notice: Extract<DriverNotice, { kind: 'batch_failed' | 'batch_effects_failed' }>,
  ): void => {
    const pass = notice.kind === 'batch_failed' ? notice.pass : 'effects';
    noteFailing(notice.batchId, pass, notice.error, true);
    if (failureLines.failed(pass, notice.batchId, rejectionText(notice.error))) report(notice);
  };
  /** After `pass` went over the batches to its end: says which recovered, of those `own` has. */
  const passDone = (pass: FailurePass | 'effects', own: (batchId: string) => boolean): void => {
    for (const batchId of failureLines.passed(pass)) {
      if (own(batchId)) report({ kind: 'batch_recovered', batchId, pass });
    }
  };

  /** A supervisor's command that threw counts for its batch, and is said once (ADR 0335). */
  const sayCommandFailure = (notice: Extract<DriverNotice, { kind: 'command_failed' }>): void => {
    const { command, error } = notice;
    const batchId = 'batchId' in command ? command.batchId : undefined;
    if (batchId !== undefined) noteFailing(batchId, 'supervisor', error, true);
    const key = `${command.kind} ${batchId ?? ''}`;
    if (failureLines.failed('command', key, rejectionText(error))) report(notice);
  };

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
    report: (notice) => {
      if (notice.kind === 'batch_failed') sayFailure(notice);
      else if (notice.kind === 'command_failed') sayCommandFailure(notice);
      else report(notice);
    },
    acts: (batchId) => !others.has(batchId),
  });

  const runs = new Map<string, { ref: AttemptRef; run: RunningAttempt }>();
  // The runs it stopped as their batch's pause reached its stopAt, by key, until they end (ADR 0202).
  const stoppedByPause = new Set<string>();
  // The runs that ended, with the error of each whose end rejected.
  const ended: { ref: AttemptRef; end: AttemptEnd; rejected?: { error: unknown } }[] = [];
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

  /** Whether `batchId` may be this driver's: `holds` lets it, and it holds it or takes it. */
  const mayHold = (batchId: string): boolean =>
    holds(batchId) && (held.has(batchId) || takes(batchId));

  /**
   * Whether a throw while it visited `batchId` is this driver's to say: never of a batch it does not
   * take or another driver holds (ADR 0328). What cannot be said, a store's fault among it, counts
   * as its own, so the fault is said.
   */
  const itsOwn = (batchId: string): boolean => {
    try {
      if (!mayHold(batchId)) return false;
      const holder = store.batchLeases(clock()).find((lease) => lease.batchId === batchId);
      return holder === undefined || holder.owner === owner;
    } catch {
      return true;
    }
  };

  /** Whether the driver holds `batchId` now: it renews the lease it holds, or takes a free one. */
  const claim = (batchId: string): boolean => {
    if (!mayHold(batchId)) return false;
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

  /**
   * Issues `command` with `also`'s writes in the transaction that renews `batchId`'s lease, so a
   * driver that lost the batch, as to a takeover since it last claimed it, does nothing more there
   * (ADR 0124): the batch is lost instead. False when it is not recorded.
   */
  const issueHolding = (
    batchId: string,
    command: EngineCommand,
    also?: (tx: EventStoreTransaction) => void,
  ): boolean => {
    let holder: BatchLease | undefined;
    const decision = log.issue(
      (tx) => {
        const hold = holdBatch(tx, { batchId, owner, now: clock(), leaseMs });
        if (hold.kind === 'held') return command;
        holder = hold.lease;
        return { refused: `batch ${batchId} is driven by ${hold.lease.owner}` };
      },
      clock(),
      also,
    );
    if (holder !== undefined) {
      lose(batchId, holder);
      return false;
    }
    if (decision.kind === 'refused') {
      report({ kind: 'refused', command, reason: decision.reason });
      return false;
    }
    return true;
  };

  /** Records the start `event` under the batch's lease, with `also`'s writes (ADR 0124). */
  const recordStart = (
    event: Extract<RecordedEvent, { type: 'step.started' }>,
    also?: (tx: EventStoreTransaction) => void,
  ): boolean => issueHolding(event.batchId, { kind: 'record', event }, also);

  const leaseAttempt = (tx: EventStoreTransaction, key: string): void =>
    tx.putLease({ attemptKey: key, owner, expiresAt: new Date(clock().getTime() + leaseMs) });
  /** The owner of the live lease of attempt `key`, if any. */
  const leaseOwner = (key: string): string | undefined =>
    store.currentLeases(clock()).find((lease) => lease.attemptKey === key)?.owner;
  /** Lets the lease of attempt `key` go unless another driver's live lease holds it (ADR 0124). */
  const releaseAttempt = (key: string): void =>
    store.withTransaction((tx) => {
      const holder = leaseOwner(key);
      if (holder === undefined || holder === owner) tx.releaseLease(key);
    });

  /**
   * Records the start of an attempt under its lease, with the worktree it was given and, for a
   * brewer's, the session it runs in, before claude can write anything under it (ADR 0116); false
   * when it cannot start. An attempt whose worktree cannot be made fails retryably: whatever is in
   * the way stays, and the next attempt has names of its own (ADR 0029).
   */
  const startAttempt = async (ref: AttemptRef, key: string): Promise<boolean> => {
    // An interactive step's session opens now: a person's wait, which the status shows (ADR 0222).
    const since = interactiveOf(log.state(), recipes, ref)
      ? { interactiveSince: clock().toISOString() }
      : {};
    const started = { type: 'step.started', ...ref, ...since } as const;
    if (worktrees.length === 0) {
      return recordStart(started, (tx) => leaseAttempt(tx, key));
    }
    // The lease first: only the holder of an attempt's lease may make its worktree. Read in the
    // transaction that writes it: another driver that lost the batch to a takeover may have
    // leased the attempt since the pass read its leases, and the start waits for it (ADR 0124).
    const leased = store.withTransaction((tx) => {
      const holder = leaseOwner(key);
      if (holder !== undefined && holder !== owner) return false;
      leaseAttempt(tx, key);
      return true;
    });
    if (!leased) return false;
    if (inCheckouts(log.state(), ref.batchId)) return startInCheckouts(ref, key, started);
    let repository: RepositoryWorktrees;
    let made: AttemptWorktree;
    let fallback: string | undefined;
    try {
      const state = log.state();
      repository = repositoryOf(state, ref.batchId, worktrees);
      const batch = state.batches.get(ref.batchId);
      if (batch === undefined) throw new Error(`no batch ${ref.batchId}`);
      const { recreate } = repository.manager;
      const resumed = await resumption(batch, ref, (found) =>
        recreate === undefined || !('worktree' in found)
          ? undefined
          : async () => {
              const { commit } = found.worktree;
              return { path: (await recreate(found.from, commit)).path, start: commit };
            },
      );
      if (resumed.kind === 'resumed') {
        // In the worktree of the session it continues, with none of its own (ADR 0029).
        const event = { ...started, session: resumed.session };
        if (!recordStart(event)) {
          releaseAttempt(key);
          return false;
        }
        // A routed fix's merge, kept in that worktree or made again in one recreated without it
        // (ADR 0244).
        if (!routedMerge(batch, ref) || resumed.start === undefined) return true;
        const { worktree: path } = resumed.session;
        return mergeBase(ref, key, repository, { path, commit: resumed.start });
      }
      fallback = resumed.fallback;
      // A fresh start would run out of the same budget: the retry ends here (ADR 0175).
      if (afterOverrun(batch, ref)) {
        const why = fallback ?? `${ref.stepId}#${ref.attempt - 1} has no session to resume`;
        const reason = `the turn budget ran out, and its session cannot be resumed: ${why}`;
        const ending = { kind: 'failed', retryable: false, reason } as const;
        if (recordStart(started)) issue({ kind: 'finish', ...ref, ending });
        releaseAttempt(key);
        return false;
      }
      // At the commits of the steps before it (ADR 0066), or for the step a red proof proves, at
      // its own latest success, so its new tests come before the code (ADR 0358).
      // The recipe the attempt was scheduled under (ADR 0310).
      const name = attemptRecipeOf(state, ref);
      const proven = name !== undefined && recipes.find(name)?.proven(ref.stepId) === true;
      made = await repository.manager.create(
        ref,
        attemptStart(batch, ref.stepId, repository, proven),
      );
    } catch (error) {
      const reason = `the attempt could not get its worktree: ${messageOf(error)}`;
      const ending = { kind: 'failed', retryable: true, reason } as const;
      if (recordStart(started)) issue({ kind: 'finish', ...ref, ending });
      releaseAttempt(key);
      return false;
    }
    const worktree = { repo: repository.repo, ...made };
    const session = brews(ref)
      ? {
          session: {
            id: sessionId(),
            worktree: made.path,
            ...(fallback === undefined ? {} : { fallback }),
          },
        }
      : {};
    if (!recordStart({ ...started, ...session, worktree })) {
      releaseAttempt(key);
      return false;
    }
    return mergeBase(ref, key, repository, made);
  };

  /**
   * Whether an attempt of `batchId` runs in checkouts of every repository instead of a worktree: a
   * Brewery order, with no repository of its own, in a Brewery of several (ADR 0301).
   */
  const inCheckouts = (state: State, batchId: string): boolean =>
    worktrees.length > 1 && ownRepoOf(state, batchId) === undefined;

  /**
   * Makes a checkout of every repository for attempt `ref`, each at what `at` gives it, in one
   * folder (ADR 0301): that folder and what to record of each.
   */
  const checkOut = async (
    ref: AttemptRef,
    at: (repository: RepositoryWorktrees) => Target,
  ): Promise<{ folder: string; checkouts: CheckoutRef[] }> => {
    const checkouts: CheckoutRef[] = [];
    for (const repository of worktrees) {
      const { repo, alias, manager } = repository;
      if (manager.checkout === undefined) throw new Error(`${repo} cannot be checked out here`);
      const made = await manager.checkout(ref, checkoutName(repo, alias), at(repository));
      checkouts.push({ repo, path: made.path, commit: made.commit });
    }
    const [first] = checkouts;
    if (first === undefined) throw new Error('the Brewery lists no repository');
    return { folder: dirname(first.path), checkouts };
  };

  /**
   * Starts an attempt of a Brewery order in a Brewery of several repositories (ADR 0301): a
   * read-only one in a folder with a checkout of each at its base, or in the folder of the session
   * it continues, made again at the recorded commits. Any other attempt fails for good: such an
   * order only plans.
   */
  const startInCheckouts = async (
    ref: AttemptRef,
    key: string,
    started: Extract<RecordedEvent, { type: 'step.started' }>,
  ): Promise<boolean> => {
    const fail = (ending: Ending): false => {
      if (recordStart(started)) issue({ kind: 'finish', ...ref, ending });
      releaseAttempt(key);
      return false;
    };
    if (!reads(ref)) {
      const reason = `step ${ref.stepId} writes, and a Brewery order in a Brewery of ${worktrees.length} repositories only plans: label it recipe:mash, or file it in its repository with the intake label`;
      return fail({ kind: 'failed', retryable: false, reason });
    }
    let fallback: string | undefined;
    let made: { folder: string; checkouts: CheckoutRef[] };
    try {
      const batch = log.state().batches.get(ref.batchId);
      if (batch === undefined) throw new Error(`no batch ${ref.batchId}`);
      const resumed = await resumption(batch, ref, (found) =>
        'checkouts' in found
          ? async () => {
              const back = await checkOut(found.from, ({ repo }) => {
                const recorded = found.checkouts.find((each) => sameRepo(each.repo, repo));
                if (recorded === undefined) throw new Error(`no checkout of ${repo} was recorded`);
                return { kind: 'resume', commit: recorded.commit };
              });
              return { path: back.folder };
            }
          : undefined,
      );
      if (resumed.kind === 'resumed') {
        if (recordStart({ ...started, session: resumed.session })) return true;
        releaseAttempt(key);
        return false;
      }
      fallback = resumed.fallback;
      // A fresh start would run out of the same budget: the retry ends here (ADR 0175).
      if (afterOverrun(batch, ref)) {
        const why = fallback ?? `${ref.stepId}#${ref.attempt - 1} has no session to resume`;
        const reason = `the turn budget ran out, and its session cannot be resumed: ${why}`;
        return fail({ kind: 'failed', retryable: false, reason });
      }
      made = await checkOut(ref, ({ base }) => ({ kind: 'new', base }));
    } catch (error) {
      const reason = `the attempt could not get its checkouts: ${messageOf(error)}`;
      return fail({ kind: 'failed', retryable: true, reason });
    }
    const session = {
      id: sessionId(),
      worktree: made.folder,
      ...(fallback === undefined ? {} : { fallback }),
    };
    if (recordStart({ ...started, session, checkouts: made.checkouts })) return true;
    releaseAttempt(key);
    return false;
  };

  /**
   * Merges the base into the worktree of `ref` before it runs, when its step is the recipe's last
   * check before the pull request (ADR 0164), or a failing check on the pull request's merged tree
   * sent it back (ADR 0226): through the ledger, under an effect's deadline, so a
   * kill on either side of it never merges twice. True when the attempt runs; otherwise it is
   * finished, Stuck on the files a merge conflicts in or failed retryably, and lets its lease go.
   */
  const mergeBase = async (
    ref: AttemptRef,
    key: string,
    { merge }: RepositoryWorktrees,
    made: Pick<AttemptWorktree, 'path' | 'commit'>,
  ): Promise<boolean> => {
    if (merge === undefined) return true;
    const batch = log.state().batches.get(ref.batchId);
    const name = batch?.recipe?.name;
    if (batch === undefined || name === undefined) return true;
    // Also at the start of a fix its pull request sent back, its conflict kept for the brewer: the
    // failure, or the conflict, is only there (ADR 0226, ADR 0244).
    const keep = routedMerge(batch, ref);
    const merges = recipes.find(name)?.mergesBase(ref.stepId) === true || keep;
    if (!merges) return true;
    let ending: Ending | undefined;
    // Renewed before it, as before every effect: none is renewed during one (ADR 0044).
    heartbeat();
    try {
      const tree = { path: made.path, start: made.commit };
      const target = baseMergeTarget(merge, tree, ref.stepId, keep);
      const merging = baseMergeKey(ref);
      const { result } = await withinDeadline(merging, (signal) =>
        applyEffect(ledger, merging, target, signal),
      );
      ending = mergeEnding(result, merge.base);
    } catch (error) {
      const reason = `the base could not be merged: ${messageOf(error)}`;
      ending = { kind: 'failed', retryable: true, reason };
    }
    if (ending === undefined) return true;
    if (!issue({ kind: 'finish', ...ref, ending }, (tx) => tx.releaseLease(key))) {
      releaseAttempt(key);
    }
    return false;
  };

  /**
   * How `ref` ended, with a `done` failed retryably while the conflict its start merge kept is
   * unconcluded in its worktree (ADR 0244). Never throws: git that cannot answer fails it the same.
   */
  const concluded = async (ref: AttemptRef, end: AttemptEnd): Promise<AttemptEnd> => {
    if (end.ending.kind !== 'succeeded' || worktrees.length === 0) return end;
    try {
      const state = log.state();
      const result = startMergeOf(state, ref);
      if (result?.kept === undefined) return end;
      const { merge } = repositoryOf(state, ref.batchId, worktrees);
      const attempt = state.batches
        .get(ref.batchId)
        ?.steps.get(ref.stepId)
        ?.attempts.get(ref.attempt);
      const path =
        attempt?.phase === 'started'
          ? (attempt.worktree?.path ?? attempt.session?.worktree)
          : undefined;
      if (merge === undefined || path === undefined) return end;
      const reason = await unconcludedMerge(merge, path, result);
      return reason === undefined
        ? end
        : { ...end, ending: { kind: 'failed', retryable: true, reason } };
    } catch (error) {
      const reason = `the merge of the base could not be read: ${messageOf(error)}`;
      return { ...end, ending: { kind: 'failed', retryable: true, reason } };
    }
  };

  /**
   * The session a retry of `ref` continues, in the worktree of the attempt that started it, given
   * back (ADR 0117); else a fresh start, with why when its brewer would have resumed one. A start
   * waits for the lease of the attempt before it anyway (ADR 0055).
   */
  const resumption = async (
    batch: Batch,
    ref: AttemptRef,
    back: (
      found: Extract<Resumption, { kind: 'resume' }>,
    ) => (() => Promise<{ path: string; start?: string }>) | undefined,
  ): Promise<
    { kind: 'resumed'; session: SessionRef; start?: string } | { kind: 'fresh'; fallback?: string }
  > => {
    // After a turn overrun whatever the brewer's retryMode: a fresh start would meet the same
    // budget (ADR 0175).
    const found =
      brews(ref) && (resumes(ref) || afterOverrun(batch, ref)) ? resumeOf(batch, ref) : undefined;
    if (found === undefined) return { kind: 'fresh' };
    if (found.kind === 'fresh') return { kind: 'fresh', fallback: found.why };
    const { from, session } = found;
    const name = `${from.stepId}#${from.attempt}`;
    const giveBack = back(found);
    if (giveBack === undefined) {
      return { kind: 'fresh', fallback: `the worktree of ${name} cannot be recreated here` };
    }
    try {
      const { path, start } = await giveBack();
      const resumedIn = { id: session, resumes: session, worktree: path };
      return { kind: 'resumed', session: resumedIn, ...(start === undefined ? {} : { start }) };
    } catch (error) {
      const why = `the worktree of ${name} could not be recreated: ${messageOf(error)}`;
      return { kind: 'fresh', fallback: why };
    }
  };

  /**
   * The limits `ref` runs with, and whether the driver could resume its session: a claude step
   * whose worktree manager recreates worktrees, so a turn overrun is retryable (ADR 0175).
   */
  const limitsOf = (ref: AttemptRef): AttemptLimits => {
    const given = limits(ref);
    if (!brews(ref) || worktrees.length === 0) return given;
    // A Brewery order's checkouts are made again by every repository's manager (ADR 0301).
    if (inCheckouts(log.state(), ref.batchId)) {
      const all = worktrees.every(({ manager }) => manager.checkout !== undefined);
      return all ? { ...given, resumable: true } : given;
    }
    const { manager } = repositoryOf(log.state(), ref.batchId, worktrees);
    return manager.recreate === undefined ? given : { ...given, resumable: true };
  };

  /**
   * Records the start of an action attempt, which the driver runs itself through its effects
   * (ADR 0071): no lease, since no process runs it and the holder of the batch's lease applies the
   * effects, and no worktree, since the push reads the task tree in the clone (ADR 0066). Without
   * actions to run it, the attempt is blocked on its environment at once.
   */
  const startAction = (ref: AttemptRef, action: RecipeAction): boolean => {
    if (!recordStart({ type: 'step.started', ...ref })) return false;
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

  /**
   * The live one of `leases` that another attempt of `ref`'s step holds, if any: one Stuck abandoned,
   * whose stopped run has not ended. `ref` starts once that lease is released or expired, which
   * the heartbeat no longer renews, and never beside it (I2, #150). The wait lasts one lease at
   * most, and `ref`'s deadline runs through it: a step whose deadline is shorter than what is left
   * of that lease goes Stuck with its deadline passed before `ref` started, as a step does whose
   * deadline passes while no driver runs. That is intended: the step could not start in time.
   */
  const stepLease = (leases: readonly AttemptLease[], ref: AttemptRef): AttemptLease | undefined =>
    leases.find(
      ({ ref: other, owner: holder }) =>
        other.batchId === ref.batchId &&
        other.stepId === ref.stepId &&
        // Or `ref` itself, which a driver that lost the batch to a takeover is starting (ADR 0124).
        (other.attempt !== ref.attempt || holder !== owner),
    );
  // The attempts it said wait for a lease, by key: each is said once, not on every pass (#155).
  // A key goes when its attempt starts; one whose batch went Stuck or ended first stays, one key
  // per retried attempt that never started, for the driver's life.
  const saidWaiting = new Set<string>();

  /** The end of an attempt whose runner broke, not the attempt: blocked on its environment (ADR 0099). */
  const brokenEnd = (ref: AttemptRef, error: unknown) => {
    const summary = rejectionSummary(error);
    const ending = { kind: 'blocked', blockerKind: 'environment', summary } as const;
    return { ref, end: { ending }, rejected: { error } };
  };

  /**
   * Whether the attempt `ref` of a claimed order waits for the engineer instead of starting: its
   * issue changed since its approval, so it goes Stuck with the question, or the check could not
   * read the issue, so the attempt fails before it starts and is retried (ADR 0368).
   */
  const changedOrder = async (batch: Batch, ref: AttemptRef, key: string): Promise<boolean> => {
    if (orderCheck === undefined || batch.repo === undefined) return false;
    // A check step reads nothing of the issue; a brewer reads its text, an action its title.
    if (!brews(ref) && actionOf(log.state(), recipes, ref) === undefined) return false;
    let changes: Awaited<ReturnType<OrderCheck>>;
    try {
      changes = await orderCheck(batch);
    } catch (error) {
      const reason = `the order could not be checked for changes since its approval: ${messageOf(error)}`;
      const ending = { kind: 'failed', retryable: true, reason } as const;
      const started = { type: 'step.started', ...ref } as const;
      if (recordStart(started, (tx) => leaseAttempt(tx, key)))
        issue({ kind: 'finish', ...ref, ending });
      releaseAttempt(key);
      return true;
    }
    if (changes === undefined) return false;
    issueHolding(batch.id, { kind: 'order_changed', ...ref, ...changes });
    return true;
  };

  /** Starts the scheduled attempts of `batch` that may start; whether any step of it moved. */
  const driveBatch = async (
    batch: Batch,
    leases: readonly AttemptLease[],
    refused: Set<string>,
  ): Promise<boolean> => {
    let moved = false;
    // A paused batch starts nothing until it continues (ADR 0202).
    if (batch.lane.kind !== 'brewing' || pauseOf(log.state(), batch) !== undefined) return moved;
    for (const [stepId, step] of batch.steps) {
      const latest = runningAttempt(step);
      if (latest?.phase !== 'scheduled') continue;
      // Another driver's batch, or one this driver does not take, is not its to start.
      if (!claim(batch.id)) continue;
      const ref = { batchId: batch.id, stepId, attempt: latest.attempt };
      // No brewer starts while a usage window that holds its family is closed; a check or an
      // action does (ADR 0206, ADR 0215).
      const held = brews(ref) && windowHolds(log.state().usageWindows, family(ref));
      if (held && actionOf(log.state(), recipes, ref) === undefined) continue;
      const key = attemptKey.encode(ref);
      if (refused.has(key)) continue;
      const lease = stepLease(leases, ref);
      if (lease !== undefined) {
        if (!saidWaiting.has(key)) {
          saidWaiting.add(key);
          const { expiresAt } = lease;
          report({ kind: 'waiting_for_lease', ref, waitsFor: lease.ref, expiresAt });
        }
        continue;
      }
      saidWaiting.delete(key);
      moved = true;
      // No attempt of a claimed order reads its issue once it changed since its approval (ADR 0368).
      if (await changedOrder(batch, ref, key)) {
        refused.add(key);
        continue;
      }
      // A person runs an interactive step's session, in a driver that opens one (ADR 0222).
      if (!sessions && interactiveOf(log.state(), recipes, ref)) {
        // A refusal (the attempt moved on meanwhile) is not asked again this drive.
        if (!issue({ kind: 'await_session', ...ref })) refused.add(key);
        continue;
      }
      const action = actionOf(log.state(), recipes, ref);
      if (action !== undefined) {
        if (!startAction(ref, action)) refused.add(key);
        continue;
      }
      let run: RunningAttempt;
      try {
        if (!(await startAttempt(ref, key))) {
          refused.add(key);
          continue;
        }
        run = runner.start({ ref, limits: limitsOf(ref) });
      } catch (error) {
        // One that has not started is the batch's failure, tried again next drive.
        if (attemptOf(log.state(), ref)?.phase !== 'started') throw error;
        // Recorded as started, with no run: it ends at the step boundary as a run that rejects
        // does, rather than waiting a lease to be lost and retried the same way (ADR 0328).
        ended.push(brokenEnd(ref, error));
        continue;
      }
      runs.set(key, { ref, run });
      run.ended
        .then((end) => concluded(ref, end))
        .then(
          (end) => ended.push({ ref, end }),
          // Its process, which may still run, is stopped before its lease goes (ADR 0099).
          // Neither can throw, so the end always reaches the step boundary and nothing is left floating.
          (error: unknown) => {
            ended.push(brokenEnd(ref, error));
            try {
              run.stop();
            } catch {}
          },
        );
    }
    return moved;
  };

  const driveNow = async (): Promise<void> => {
    // A start the guard refuses is tried once per drive: the attempt's deadline covers it.
    const refused = new Set<string>();
    // A batch that threw is left for the rest of this drive and never counts as moved, so a drive
    // ends, and says it once; the next tick's tries it again (ADR 0328).
    const setAside = new Set<string>();
    const failed = (pass: 'drive' | 'cleanup', batchId: string, error: unknown): void => {
      setAside.add(batchId);
      if (itsOwn(batchId)) sayFailure({ kind: 'batch_failed', batchId, pass, error });
    };
    for (;;) {
      let moved = false;
      // Once per pass: a run that ended in the pass before let its lease go.
      const leases = store.currentLeases(clock()).flatMap(({ attemptKey: key, ...lease }) => {
        const ref = attemptKey.decode(key);
        return ref === undefined ? [] : [{ ref, ...lease }];
      });
      for (const batch of log.state().batches.values()) {
        if (setAside.has(batch.id)) continue;
        try {
          if (await driveBatch(batch, leases, refused)) moved = true;
        } catch (error) {
          failed('drive', batch.id, error);
        }
      }
      // Let the runs that ended settle their promises.
      await new Promise((resolve) => setImmediate(resolve));
      // One end at a time off the queue, so none is dropped when the handling of another throws.
      for (let next = ended.shift(); next !== undefined; next = ended.shift()) {
        const { ref, end, rejected } = next;
        const key = attemptKey.encode(ref);
        runs.delete(key);
        // The step boundary: an attempt that ended is recorded, also in a batch another driver
        // took meanwhile, and lets its lease go, also when Stuck abandoned it and its finish is
        // refused (I2). An end whose reading or record throws keeps its lease until it expires, and
        // the supervisor loses the attempt; a throw from the read after it is reported the same way.
        // Either way the other ends of the pass go on (#278, #289).
        const paused = stoppedByPause.delete(key);
        let command: EngineCommand | undefined;
        try {
          const limit = end.ending.kind === 'blocked' ? end.ending.usageLimit : undefined;
          const reopensAt = limit && reopenOf(limit.resets, clock(), zone());
          command = finishOf(ref, end, paused, reopensAt);
          if (!issue(command, (tx) => tx.releaseLease(key))) releaseAttempt(key);
          // An attempt of an ended batch held its worktree until now.
          if (cleaners.length > 0 && batchIsOver(log.state(), ref.batchId)) {
            toClean.add(ref.batchId);
          }
        } catch (error) {
          // Said each time, unlike a pass's: each end is its own, and comes once.
          report(
            command === undefined
              ? { kind: 'batch_failed', batchId: ref.batchId, pass: 'drive', error }
              : { kind: 'command_failed', command, error },
          );
        }
        if (rejected !== undefined) report({ kind: 'run_failed', ref, error: rejected.error });
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
        if (setAside.has(batchId)) continue;
        try {
          // Asked before the cleanup reads its claims: a lease it keeps a worktree for may expire
          // while its git steps run. An ended batch gets no new lease, so asking early misses none.
          if (leasedBatches().has(batchId)) cleanedLeased.add(batchId);
          doing({ kind: 'clean' });
          report({ kind: 'cleaned', batchId, report: await cleanup.batchEnded(batchId) });
          toClean.delete(batchId);
        } catch (error) {
          // It stays for the next drive: no later look at the store would clean it (ADR 0328).
          failed('cleanup', batchId, error);
        }
      }
      if (!moved) {
        // A batch the drive no longer reads has not recovered: its line goes unsaid.
        passDone('drive', (batchId) => {
          const state = log.state();
          const batch = state.batches.get(batchId);
          return (
            batch?.lane.kind === 'brewing' && pauseOf(state, batch) === undefined && itsOwn(batchId)
          );
        });
        passDone('cleanup', itsOwn);
        return;
      }
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
  const pending = (
    state: State,
    batchId: string,
    // Takes a source that could not be read, whose others' effects are then due (ADR 0335).
    unread?: (error: UnreadSources) => void,
  ): { key: EffectKey; target: EffectTarget }[] => {
    const read = (source: DriverEffects): readonly EffectKey[] => {
      try {
        return source.due(state, batchId);
      } catch (error) {
        if (unread === undefined || !(error instanceof UnreadSources)) throw error;
        unread(error);
        return error.readable;
      }
    };
    const due = [
      ...(effects === undefined
        ? []
        : read(effects).map((key) => ({ key, target: effects.target }))),
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

  /**
   * Records what the effects of `batchId` call for once every one is in the ledger, under the
   * batch's lease (ADR 0285). A driver killed before it leaves them to the next pass.
   */
  const recordAfter = (batchId: string): void => {
    const state = log.state();
    if (effects?.recorded === undefined || pending(state, batchId).length > 0) return;
    const events = effects.recorded(state, batchId);
    if (events.length === 0 || !claim(batchId)) return;
    for (const event of events) issue({ kind: 'record', event });
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

  /**
   * Whether `batchId` was taken over from a driver whose lease has not run out: an effect it began
   * under that lease may still be applied, and ends before it does (ADR 0124).
   */
  const awaitsTakeover = (batchId: string): boolean => {
    const until = log.state().batches.get(batchId)?.takeover?.until;
    return until !== undefined && Date.parse(until) > clock().getTime();
  };

  // Each effect under its batch's lease, renewed before it: two drivers never apply one at once,
  // and passes of this driver run one after another (ADR 0033). False when an effect failed.
  const applyBatch = async (batchId: string): Promise<boolean> => {
    // The next effect due from the state as the one before it left it: an effect may change
    // what follows, as an empty push leaves no pull request to open (ADR 0071). A key is tried
    // once a pass.
    const tried = new Set<string>();
    // A source that could not be read: the others' effects are applied, and the pass fails at its
    // end, before anything reads "nothing pending" as all done (ADR 0335).
    const latest: { unread?: UnreadSources } = {};
    for (;;) {
      delete latest.unread;
      const next = pending(log.state(), batchId, (error) => {
        latest.unread = error;
      }).find(({ key }) => !tried.has(effectKey.encode(key)));
      if (next === undefined) break;
      const { key, target } = next;
      tried.add(effectKey.encode(key));
      heartbeat();
      if (!claim(batchId) || awaitsTakeover(batchId)) return true;
      doing({ kind: 'effect', key });
      try {
        await withinDeadline(key, (signal) => applyEffect(ledger, key, target, signal));
      } catch (error) {
        noteFailing(batchId, 'effects', error, false);
        if (failureLines.failed('effect', effectKey.encode(key), rejectionText(error))) {
          report({ kind: 'effect_failed', key, error });
        }
        if (latest.unread !== undefined) throw latest.unread;
        return false;
      }
    }
    if (latest.unread !== undefined) throw latest.unread;
    finishActions(batchId);
    recordAfter(batchId);
    return true;
  };

  /**
   * The passes of one tick (ADR 0355): the batches whose effects failed in its first pass, before
   * the drive, which wait for the next tick rather than its second pass, and whether this pass is
   * the first, after which no batch is said to have recovered.
   */
  interface TickPasses {
    setAside: Set<string>;
    first: boolean;
  }
  const applyPass = async (passes?: TickPasses): Promise<void> => {
    if (effects === undefined && actions === undefined) return;
    const state = log.state();
    for (const batch of state.batches.values()) {
      if (passes?.setAside.has(batch.id)) continue;
      // Whatever the pass over one batch throws is reported and left: the others go on (ADR 0327).
      try {
        if (!(await applyBatch(batch.id))) passes?.setAside.add(batch.id);
      } catch (error) {
        passes?.setAside.add(batch.id);
        if (itsOwn(batch.id)) {
          sayFailure({ kind: 'batch_effects_failed', batchId: batch.id, error });
        }
      }
    }
    if (passes?.first === true) return;
    passDone('effects', itsOwn);
    failureLines.passed('effect');
  };
  let pass: Promise<unknown> = Promise.resolve();
  const applyEffects = (passes?: TickPasses): Promise<void> => {
    const next = pass.then(() => applyPass(passes));
    pass = next.catch(() => {});
    return next;
  };

  /**
   * Whether `ref`'s batch was taken from this driver to resume `ref`'s step, by an owner that holds
   * it still (ADR 0127): the fold keeps the latest takeover after that owner let the batch go.
   */
  const resumedElsewhere = (state: State, ref: AttemptRef): boolean => {
    const takeover = state.batches.get(ref.batchId)?.takeover;
    if (held.has(ref.batchId) || takeover?.from !== owner || takeover.resumes !== ref.stepId) {
      return false;
    }
    const holder = store.batchLeases(clock()).find((lease) => lease.batchId === ref.batchId);
    return holder?.owner === takeover.to;
  };

  /**
   * Whether `batchId` has no effect due. One that cannot be read has not finished, so it stays held
   * and the others are let go; the pass over its effects says why (ADR 0327).
   */
  const noneDue = (state: State, batchId: string): boolean => {
    try {
      return pending(state, batchId).length === 0;
    } catch {
      return false;
    }
  };

  /**
   * Writes a mark under the batch's lease, so one driver writes it; a throw stops no other. It does
   * not hold the batch: a free one's lease lapses, so a mark never changes who may drive it.
   */
  const writeMark = (batchId: string, command: EngineCommand): boolean => {
    try {
      return mayHold(batchId) && issueHolding(batchId, command);
    } catch (error) {
      if (failureLines.failed('mark', batchId, rejectionText(error))) {
        report({ kind: 'command_failed', command, error });
      }
      return false;
    }
  };

  /**
   * The end of a tick's passes: a batch that has failed for an hour is marked, Stuck when it brews
   * and its reading failed (ADR 0335), and one that carries a mark and went clean recovers. Stuck
   * on failing keeps its mark until a person moves it: Stuck reads too little to call that clean.
   */
  const settleFailing = (): void => {
    const state = log.state();
    const over = failing.settle(
      (batchId) => state.batches.get(batchId)?.failing !== undefined,
      clock(),
    );
    for (const { batchId, pass, summary, since, reading } of over) {
      const batch = state.batches.get(batchId);
      if (batch?.failing !== undefined && (!reading || failingStep(batch) === undefined)) continue;
      const command = { kind: 'mark_failing', batchId, pass, summary, since, reading } as const;
      if (writeMark(batchId, command)) failing.marked(batchId);
    }
    for (const { id: batchId, lane, failing: mark } of state.batches.values()) {
      if (mark === undefined || failing.has(batchId)) continue;
      // A takeover's wait tried none of its effects, so it says nothing of them (ADR 0124).
      if (stuckOnFailing(lane) || awaitsTakeover(batchId)) continue;
      writeMark(batchId, { kind: 'record', event: { type: 'batch.recovered', batchId } });
    }
    failureLines.passed('mark');
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
    passDone('supervisor', (batchId) => !others.has(batchId));
    failureLines.passed('command');
    // Stops the processes of attempts that Stuck abandoned (ADR 0027), whose batch ended, or that
    // the log shows finished while this runner still runs them: another driver lost them. Also
    // the run of a step whose batch was taken from this driver to resume that step's session: it
    // ends at the step boundary, and the new holder continues the session (ADR 0127).
    const current = log.state();
    for (const { ref, run } of runs.values()) {
      // A run this driver runs is its own to say, whoever holds its batch now. The next tick stops
      // one whose stop threw again, and the others go on (ADR 0328).
      try {
        const attempt = attemptOf(current, ref);
        if (attempt === undefined) continue;
        if (
          isOver(attempt) ||
          batchIsOver(current, ref.batchId) ||
          resumedElsewhere(current, ref)
        ) {
          run.stop();
          continue;
        }
        // What still runs of a paused batch at its pause's stopAt (ADR 0202).
        const batch = current.batches.get(ref.batchId);
        const key = attemptKey.encode(ref);
        if (batch !== undefined && !stoppedByPause.has(key) && stopsNow(current, batch, now)) {
          run.stop();
          stoppedByPause.add(key);
        }
      } catch (error) {
        sayFailure({ kind: 'batch_failed', batchId: ref.batchId, pass: 'runs', error });
      }
    }
    passDone('runs', () => true);
    // Before the drive as well, which awaits each start's worktree and the ends that come at once:
    // what a person's command changed shows on the issue before a step starts (ADR 0355).
    const setAside = new Set<string>();
    await applyEffects({ setAside, first: true });
    await drive();
    await applyEffects({ setAside, first: false });
    settleFailing();
    // A batch that ended, with no attempt running and no effect due, is let go.
    const state = log.state();
    const running = new Set([...runs.values()].map(({ ref }) => ref.batchId));
    const done = [...held].filter(
      (batchId) => batchIsOver(state, batchId) && !running.has(batchId) && noneDue(state, batchId),
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
    applyEffects: () => applyEffects(),
    state: log.state,
    progress: (ref) => runner.progress(ref),
    close: () => {
      // Their ends are not recorded: the next start of this owner loses them (ADR 0033, ADR 0063).
      for (const { run } of runs.values()) {
        try {
          run.stop();
        } catch {}
      }
      lock.release();
    },
  };
};
