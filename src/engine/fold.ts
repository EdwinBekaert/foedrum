// The fold: current state from the event log (architecture §4.1, invariant I3).
// Pure: no clock, randomness or I/O, and neither the events nor the state passed in are changed.

import type {
  Answer,
  ClaudeReport,
  Dependency,
  Event,
  GravityReading,
  HeadCheck,
  OrderRef,
  PlanOrigin,
  RankPlace,
  Receipt,
  RecordedFindings,
  ScheduleRoute,
  SessionRef,
  StuckOption,
  StuckReason,
  Surface,
  Usage,
  UsageLimitName,
  UsageScope,
  WaitCondition,
  WorktreeRef,
} from '../schemas/events.ts';
import type { StepOutcome } from '../schemas/step-outcome.ts';
import type { AttemptRef } from './attempt-key.ts';
import { effectKey } from './effect-key.ts';
import { ranIn } from './session-resume.ts';
import { scopeOf } from './usage-window.ts';

/** Where a batch is: the board lanes (architecture §4.3), plus cancelled. */
export type Lane =
  /** `routeBy`: the routing deadline (ADR 0032). */
  | { kind: 'ordered'; routeBy: string }
  | { kind: 'brewing' }
  | { kind: 'conditioning'; on: WaitCondition; remindAt: string }
  | { kind: 'stuck'; reason: StuckReason; options: readonly StuckOption[]; remindAt: string }
  | { kind: 'on_tap'; pullRequests: readonly string[] }
  | { kind: 'cancelled'; by: string; via: Surface };

/**
 * An attempt that had not finished when its batch got Stuck is `abandoned` (ADR 0025): whatever
 * the batch does next, it schedules new attempts, and the abandoned one never starts or finishes.
 */
export type Attempt =
  | {
      phase: 'scheduled';
      attempt: number;
      deadlineAt: string;
      route?: ScheduleRoute;
      /** Scheduled because the attempt before it failed (ADR 0117). */
      retry?: true;
      /** Scheduled because a human answered the questions of the attempt before it (ADR 0118). */
      answered?: true;
      /** The recipe its batch brewed when it was scheduled (#657); absent without one. */
      recipe?: string;
      abandoned?: true;
    }
  | {
      phase: 'started';
      attempt: number;
      deadlineAt: string;
      route?: ScheduleRoute;
      /** Scheduled because the attempt before it failed (ADR 0117). */
      retry?: true;
      /** Scheduled because a human answered the questions of the attempt before it (ADR 0118). */
      answered?: true;
      /** The recipe its batch brewed when it was scheduled (#657); absent without one. */
      recipe?: string;
      session?: SessionRef;
      worktree?: WorktreeRef;
      /** An interactive step's: when its session opened, a person's wait (ADR 0222). */
      interactiveSince?: string;
      abandoned?: true;
    }
  | {
      phase: 'finished';
      attempt: number;
      deadlineAt: string;
      route?: ScheduleRoute;
      /** Scheduled because the attempt before it failed (ADR 0117). */
      retry?: true;
      /** Scheduled because a human answered the questions of the attempt before it (ADR 0118). */
      answered?: true;
      /** The recipe its batch brewed when it was scheduled (#657); absent without one. */
      recipe?: string;
      session?: SessionRef;
      worktree?: WorktreeRef;
      outcome: StepOutcome;
      usage?: Usage;
      /** A check step's gravity readings (ADR 0069), or a brewer's setup's (ADR 0163). */
      readings?: readonly GravityReading[];
      /** What claude reported in its init event, when it came (ADR 0116). */
      claude?: ClaudeReport;
      /** What a brewer's attempt took, once its stream was read (ADR 0172). */
      receipt?: Receipt;
      /** Stopped when its batch's pause reached its stopAt: it counts against no retry (ADR 0202). */
      paused?: true;
      /** Ended as claude hit a usage limit: it counts against no retry (ADR 0206). */
      usageLimited?: true;
      /** A blocking Taster's findings, when it asked for changes (ADR 0221). */
      findings?: RecordedFindings;
    };

export interface Input {
  by: string;
  via: Surface;
  answers: readonly Answer[];
  /** The attempt whose questions it answers: the step's latest when it came (#656). */
  attempt: number;
}

export interface Step {
  id: string;
  /** By attempt number. */
  attempts: ReadonlyMap<number, Attempt>;
  inputs: readonly Input[];
}

/** The attempt of `step` with the highest number, if it has one: the step's latest (I2). */
export const latestAttempt = (step: Step): Attempt | undefined =>
  step.attempts.get(Math.max(...step.attempts.keys()));

/**
 * The latest attempt of `step` when it runs: neither finished nor abandoned by Stuck (I2,
 * ADR 0025, ADR 0055).
 */
export const runningAttempt = (step: Step): Exclude<Attempt, { phase: 'finished' }> | undefined => {
  const latest = latestAttempt(step);
  return latest === undefined || latest.phase === 'finished' || latest.abandoned === true
    ? undefined
    : latest;
};

/** The attempt of `step` with the highest number below `n`, if any: the one attempt `n` follows. */
export const attemptBefore = (step: Step, n: number): Attempt | undefined =>
  step.attempts.get(Math.max(...[...step.attempts.keys()].filter((each) => each < n)));

/**
 * The route that scheduled the round attempt `n` of `step` is in: its own, or for a retry, or an
 * answer, that of the attempt it retries or answers, which it starts as (ADR 0117, ADR 0118).
 */
export const roundRouteOf = (step: Step, n: number): ScheduleRoute | undefined => {
  let attempt = step.attempts.get(n);
  while (attempt?.retry === true || attempt?.answered === true) {
    attempt = step.attempts.get(attempt.attempt - 1);
  }
  return attempt?.route;
};

/**
 * The recipe an attempt was scheduled under, which its batch may have left since (ADR 0260); its
 * batch's recipe for an attempt that recorded none, undefined without either.
 */
export const attemptRecipeOf = (state: State, ref: AttemptRef): string | undefined => {
  const batch = state.batches.get(ref.batchId);
  return batch?.steps.get(ref.stepId)?.attempts.get(ref.attempt)?.recipe ?? batch?.recipe?.name;
};

export interface Rewind {
  toStepId: string;
  by: string;
  via: Surface;
  shas: Readonly<Record<string, string>>;
}

/** A person's handover of a batch from the driver `from` to `to` (ADR 0124). */
export interface Takeover {
  by: string;
  via: Surface;
  from: string;
  to: string;
  /** When `from`'s lease would have expired: no effect of the batch is applied before it. */
  until: string;
  /** The step whose session `to` resumes, whose run `from` stops (ADR 0127). */
  resumes?: string;
}

/**
 * Where a batch's task tree is (ADR 0066): the branch of its latest attempt that succeeded with a
 * worktree, or the commits of its latest rewind, whichever was recorded last.
 */
export type TaskTree =
  | { kind: 'attempt'; stepId: string; attempt: number; repo: string }
  | { kind: 'rewound'; shas: Readonly<Record<string, string>> };

/**
 * The commit a batch started from in a repository (ADR 0084): the worktree's commit of its first
 * attempt there that succeeded, in the order the finishes came, or of its first attempt there
 * while none has (`succeeded` false).
 */
export interface BatchStart {
  commit: string;
  succeeded: boolean;
}

export interface Batch {
  id: string;
  /** The issue this batch brews: an order or a sub-order. */
  issue: number;
  /** The target repository of a claimed issue (ADR 0043); absent for a Brewery issue. */
  repo?: string;
  parentBatchId?: string;
  /** The plan entry a sub-order's batch was ordered from (ADR 0285). */
  plan?: PlanOrigin;
  /** It recorded its order's breakdown: an approved plan it applied (ADR 0285). */
  decomposed?: true;
  /** When it was ordered (ADR 0179); absent for an order that did not record it. */
  orderedAt?: string;
  /** What chose the recipe; a human's choice also records who issued it and from where. */
  recipe?: { name: string; reason: string } & (
    | { source: 'label' | 'router' }
    | { source: 'human'; by: string; via: Surface; askedBy?: string }
  );
  lane: Lane;
  steps: ReadonlyMap<string, Step>;
  /** The steps whose latest record is a skip (ADR 0064); absent while none is. */
  skipped?: ReadonlySet<string>;
  rewinds: readonly Rewind[];
  /** Its latest handover from one driver to another (ADR 0124); absent while it had none. */
  takeover?: Takeover;
  /** Its task tree; absent while it is the repository's base (ADR 0066). */
  taskTree?: TaskTree;
  /**
   * Where it started, by repository in lower case (GitHub names are case-insensitive); absent
   * while no attempt of it recorded a worktree. Kept in the order of the events, which the steps
   * do not follow: a recipe change or a route back runs an earlier step again later.
   */
  starts?: Readonly<Record<string, BatchStart>>;
  /** How each of its pull requests ended that has ended, by URL; absent while none has. */
  pullRequestEnds?: Readonly<Record<string, 'merged' | 'closed'>>;
  /** Its attempts in the order they started, across its steps; absent while none has. */
  path?: readonly PathAttempt[];
  /**
   * How its open pull requests merged with their base, each check in the order it was recorded
   * (ADR 0198); absent while none was.
   */
  baseChecks?: readonly BaseCheck[];
  /**
   * The latest record of the checks on each open pull request's head, by URL (ADR 0213); absent
   * while none was. A record names its head: it says nothing of another.
   */
  pullRequestChecks?: Readonly<Record<string, HeadChecks>>;
  /**
   * The latest merge-tree of its open pull request's head with each other open pull request's
   * head of the Brewery's in its repository, by the other's URL (ADR 0230); absent while none was.
   */
  pairChecks?: Readonly<Record<string, PairCheck>>;
  /**
   * The failed head of a pull request that a person's skip of a batch Stuck on its checks left as
   * it is (ADR 0219): nothing sends the batch back for it again. Absent while no skip did.
   */
  pullRequestLeft?: { pullRequest: string; head: string };
  /** The person's sign-off of its plan (ADR 0281); absent while none was given. */
  approval?: Approval;
}

/** A plan signed off: the attempt that wrote it, its digest, who signed it off, from where, when. */
export interface Approval {
  stepId: string;
  attempt: number;
  plan: string;
  by: string;
  via: Surface;
  at: string;
}

/** The checks of a finished record as one text, the same in whatever order they were read. */
export const headChecksText = ({
  checks,
  more,
}: {
  checks: readonly HeadCheck[];
  more?: number | undefined;
}): string =>
  JSON.stringify([
    checks
      .map(({ name, kind, conclusion, url }) => JSON.stringify([name, kind, conclusion, url]))
      .sort(),
    more ?? 0,
  ]);

/** Whether two finished records of a head's checks say the same, in whatever order (ADR 0213). */
export const sameHeadChecks = (
  a: { checks: readonly HeadCheck[]; more?: number | undefined },
  b: { checks: readonly HeadCheck[]; more?: number | undefined },
): boolean => headChecksText(a) === headChecksText(b);

/** One merge-tree of an open pull request's head with another open pull request's (ADR 0230). */
export interface PairCheck {
  /** The batch's own pull request, and the head of it that was merged. */
  pullRequest: string;
  head: string;
  /** The other pull request's head that was merged. */
  otherHead: string;
  /** The files they conflict in; absent when they merge cleanly. */
  conflicts?: readonly string[];
}

/** The checks on a pull request's head (ADR 0213): still running since a pass saw it, or finished. */
export type HeadChecks =
  | { kind: 'pending'; head: string; since: string }
  | { kind: 'finished'; head: string; checks: readonly HeadCheck[]; more?: number };

/**
 * The base checks of the pull request `url` of `batch` on `head` (ADR 0226): a check without a
 * head, an older log's, counts as one of any head; with no `head`, every check of `url`.
 */
export const baseChecksOn = (batch: Batch, url: string, head?: string): BaseCheck[] =>
  (batch.baseChecks ?? []).filter(
    (check) =>
      check.pullRequest === url &&
      (head === undefined || check.head === undefined || check.head === head),
  );

/** One merge-tree check of an open pull request against its base's tip (ADR 0198). */
export interface BaseCheck {
  pullRequest: string;
  /** The base branch, as the remote names it. */
  branch: string;
  tip: string;
  /** The head merged with the tip (ADR 0226); absent in a log written before it. */
  head?: string;
  /** The files it conflicts in; absent when it merges cleanly. */
  conflicts?: readonly string[];
  /** The bottle branch's tip, when someone else pushed to it: not checked, then or after. */
  branchMoved?: string;
  /** The first reading of the checks on the merged tree that did not pass (ADR 0203). */
  failed?: GravityReading;
  /** Why the checks did not run on the merged tree (ADR 0203). */
  unchecked?: string;
}

/** One attempt on a batch's path: its step and its number. */
export interface PathAttempt {
  stepId: string;
  attempt: number;
}

/**
 * An order of a Brewery issue with batches that is not a sub-order. A claimed target-repository
 * issue is an order too, but its batches keep their repository instead (`Batch.repo`, ADR 0050).
 */
export interface Order {
  issue: number;
  batchIds: readonly string[];
  /** The latest breakdown; a new decomposition replaces it. */
  subOrders: readonly number[];
  dependencies: readonly Dependency[];
}

/** A sub-order writes in exactly one repository (architecture §3.2). */
export interface SubOrder {
  issue: number;
  repo: string;
  /** The paths its plan says it changes, when the breakdown names them. */
  touches?: readonly string[];
  /** The order it was split from. */
  order: number;
  batchIds: readonly string[];
  /** Left out of the order's latest breakdown; a later breakdown that lists it again un-cancels it. */
  cancelled: boolean;
  /** The approved plan's entry it was opened from (ADR 0285). */
  plan?: PlanOrigin;
}

export interface Bottle {
  id: string;
  repo: string;
  subOrders: readonly number[];
  pullRequest: string;
}

export interface Release {
  repo: string;
  package: string;
  version: string;
  /** Its position among the merges and releases the fold recorded (`State.merges`, ADR 0216). */
  seq: number;
}

/**
 * A closed usage window (ADR 0206): which limit claude hit, its reset as claude wrote it, and when
 * the window reopens, which is an hour on when the reset could not be `read`.
 */
export interface UsageWindow {
  limit: UsageLimitName;
  resets: string;
  reopensAt: string;
  read: boolean;
}

/** The usage windows closed now, by the scope whose brewers each holds (ADR 0215). */
export type UsageWindows = Readonly<Partial<Record<UsageScope, UsageWindow>>>;

/** A person's pause of an order or of the whole Brewery (ADR 0202). */
export interface Pause {
  by: string;
  via: Surface;
  why?: string;
  /** When what still runs is stopped, and the zone it was given in. */
  stopAt?: { at: string; zone: string };
}

/**
 * A person's rank of an order of the intake's queue (ADR 0208): its place, and `seq`, which says
 * which of the ranks in force came later.
 */
export interface Rank {
  order: OrderRef;
  place: RankPlace;
  seq: number;
  by: string;
  via: Surface;
  why?: string;
}

/** The pauses in force: of the whole Brewery (`--all`), and of each order by `orderKey`. */
export interface Pauses {
  all?: Pause;
  orders: ReadonlyMap<string, Pause>;
}

export interface State {
  orders: ReadonlyMap<number, Order>;
  subOrders: ReadonlyMap<number, SubOrder>;
  batches: ReadonlyMap<string, Batch>;
  bottles: ReadonlyMap<string, Bottle>;
  releases: readonly Release[];
  /**
   * The position of each pull request's first recorded merge, by URL, counted with the releases'
   * `seq`: which release came after which merge (ADR 0216).
   */
  merges: ReadonlyMap<string, number>;
  /** The idempotency ledger: result by effect key (invariant I4). */
  effects: ReadonlyMap<string, unknown>;
  pauses: Pauses;
  /** The ranks in force, by `orderKey` (ADR 0208). */
  ranks: ReadonlyMap<string, Rank>;
  /** The usage windows closed now, by scope: no brewer attempt they hold starts (ADR 0206, ADR 0215). */
  usageWindows: UsageWindows;
}

export const emptyState: State = {
  orders: new Map(),
  subOrders: new Map(),
  batches: new Map(),
  bottles: new Map(),
  releases: [],
  merges: new Map(),
  effects: new Map(),
  pauses: { orders: new Map() },
  ranks: new Map(),
  usageWindows: {},
};

/** The key of an order's pause: its repository in lower case (GitHub's are case-insensitive), and its issue. */
export const orderKey = ({ issue, repo }: OrderRef): string =>
  `${repo?.toLowerCase() ?? ''}#${issue}`;

/**
 * The position of the next merge or release: each one recorded adds one entry to `merges` or
 * `releases`, so their sizes count them in the order of the log (ADR 0216).
 */
const nextPosition = (state: State): number => state.merges.size + state.releases.length + 1;

/**
 * A log the fold cannot replay, and where it broke. The command layer refuses such events
 * before they are appended (`admit`); the fold's check is the last line of defence, and lets
 * replay and `foedrum doctor` point at the event.
 */
export class InvalidLogError extends Error {
  override readonly name = 'InvalidLogError';
  /** The position of the event in the events passed to `fold`. */
  readonly index: number;
  readonly eventType: Event['type'];
  readonly reason: string;

  constructor(index: number, eventType: Event['type'], reason: string) {
    super(`Invalid event log at event ${index} (${eventType}): ${reason}`);
    this.index = index;
    this.eventType = eventType;
    this.reason = reason;
  }
}

/**
 * Folds `events` onto `state`; `fold(rest, fold(prefix))` equals `fold([...prefix, ...rest])`.
 * Throws an InvalidLogError when an event refers to a batch, step or attempt the log never
 * created (an applied effect, to the batch or attempt its key names), repeats one or takes an attempt out
 * of order, opens a bottle or applies an effect twice, records the end of a pull request twice,
 * decomposes a sub-order or a target-repository issue, makes an order or a target issue a
 * sub-order, or moves a sub-order to another order.
 */
export function fold(events: readonly Event[], state: State = emptyState): State {
  return events.reduce((current, event, index) => {
    try {
      return apply(current, event);
    } catch (error) {
      if (error instanceof Rejection) throw new InvalidLogError(index, event.type, error.message);
      throw error;
    }
  }, state);
}

/** Why `apply` refuses an event; `fold` adds where it happened. */
class Rejection extends Error {}

function apply(state: State, event: Event): State {
  switch (event.type) {
    case 'batch.ordered': {
      const { batchId, order, parentBatchId, plan, routeBy, at } = event;
      if (state.batches.has(batchId)) throw reject(`batch ${batchId} was already ordered`);
      if (parentBatchId !== undefined) batchOf(state, parentBatchId);
      const { repo } = order;
      if (repo !== undefined && parentBatchId !== undefined) {
        throw reject(
          `batch ${batchId} brews issue ${order.issue} of ${repo}, which is never a sub-order`,
        );
      }
      const batches = put(state.batches, batchId, {
        id: batchId,
        issue: order.issue,
        ...(repo === undefined ? {} : { repo }),
        ...(parentBatchId === undefined ? {} : { parentBatchId }),
        ...(plan === undefined ? {} : { plan }),
        ...(at === undefined ? {} : { orderedAt: at }),
        lane: { kind: 'ordered', routeBy },
        steps: new Map(),
        rewinds: [],
      });
      // A claimed target issue, whose order is a Brewery issue the driver opens (ADR 0144), stays
      // out of `orders` and `subOrders`: they hold the Brewery's own issues by number, which its
      // number would collide with (ADR 0050).
      if (repo !== undefined) return { ...state, batches };
      const subOrder = state.subOrders.get(order.issue);
      if (subOrder !== undefined) {
        return {
          ...state,
          subOrders: put(state.subOrders, order.issue, {
            ...subOrder,
            batchIds: [...subOrder.batchIds, batchId],
          }),
          batches,
        };
      }
      const existing = orderOf(state, order.issue);
      return {
        ...state,
        orders: put(state.orders, order.issue, {
          ...existing,
          batchIds: [...existing.batchIds, batchId],
        }),
        batches,
      };
    }
    case 'batch.recipe_chosen': {
      const { recipe: name, reason } = event;
      // The skips belonged to the run of the recipe before (ADR 0064).
      return updateBatch(state, event.batchId, ({ skipped: _, ...batch }) => ({
        ...batch,
        recipe:
          event.source === 'human'
            ? {
                name,
                reason,
                source: event.source,
                by: event.by,
                via: event.via,
                ...(event.askedBy === undefined ? {} : { askedBy: event.askedBy }),
              }
            : { name, reason, source: event.source },
      }));
    }
    case 'step.scheduled': {
      const { batchId, stepId, attempt, deadlineAt, route, retry, answered } = event;
      return updateBatch(state, batchId, (batch) => {
        const step = batch.steps.get(stepId) ?? { id: stepId, attempts: new Map(), inputs: [] };
        if (step.attempts.has(attempt)) throw attemptError(event, 'was already scheduled');
        const recipe = batch.recipe?.name;
        return {
          ...skipping(batch, stepId, false),
          lane: { kind: 'brewing' },
          steps: put(batch.steps, stepId, {
            ...step,
            attempts: put(step.attempts, attempt, {
              phase: 'scheduled',
              attempt,
              deadlineAt,
              ...(route === undefined ? {} : { route }),
              ...(retry === undefined ? {} : { retry }),
              ...(answered === undefined ? {} : { answered }),
              ...(recipe === undefined ? {} : { recipe }),
            }),
          }),
        };
      });
    }
    case 'step.skipped':
      return updateBatch(state, event.batchId, (batch) => ({
        ...skipping(batch, event.stepId, true),
        lane: { kind: 'brewing' },
      }));
    case 'step.started': {
      const next = updateAttempt(state, event, (current) => {
        if (current.phase !== 'scheduled') throw attemptError(event, 'was already started');
        return {
          ...current,
          phase: 'started',
          ...(event.session === undefined ? {} : { session: event.session }),
          ...(event.worktree === undefined ? {} : { worktree: event.worktree }),
          ...(event.interactiveSince === undefined
            ? {}
            : { interactiveSince: event.interactiveSince }),
        };
      });
      const { worktree, stepId, attempt } = event;
      return updateBatch(next, event.batchId, (batch) => {
        const onPath = { ...batch, path: [...(batch.path ?? []), { stepId, attempt }] };
        return worktree === undefined ? onPath : startAt(onPath, worktree, false);
      });
    }
    case 'step.finished': {
      // The worktree it ran in, and the attempt that made it: its own, or for a resumed attempt
      // the one whose session it continues (ADR 0117).
      let ran: { attempt: number; worktree: WorktreeRef } | undefined;
      const next = updateAttempt(state, event, (current, step) => {
        if (current.phase === 'scheduled') throw attemptError(event, 'was never started');
        if (current.phase === 'finished') throw attemptError(event, 'was already finished');
        ran = ranIn(step, current);
        return {
          ...current,
          phase: 'finished',
          outcome: event.outcome,
          ...(event.usage === undefined ? {} : { usage: event.usage }),
          ...(event.readings === undefined ? {} : { readings: event.readings }),
          ...(event.claude === undefined ? {} : { claude: event.claude }),
          ...(event.receipt === undefined ? {} : { receipt: event.receipt }),
          ...(event.paused === undefined ? {} : { paused: event.paused }),
          ...(event.usageLimited === undefined ? {} : { usageLimited: event.usageLimited }),
          ...(event.findings === undefined ? {} : { findings: event.findings }),
        };
      });
      if (event.outcome.kind !== 'succeeded' || ran === undefined) return next;
      // The next attempt continues from the branch this one committed on (ADR 0066).
      const { stepId } = event;
      const { attempt, worktree } = ran;
      const taskTree = { kind: 'attempt', stepId, attempt, repo: worktree.repo } as const;
      const { repo, commit } = worktree;
      return updateBatch(next, event.batchId, (batch) => ({
        ...startAt(batch, { repo, commit }, true),
        taskTree,
      }));
    }
    case 'input.received': {
      const { stepId, by, via, answers } = event;
      return updateBatch(state, event.batchId, (batch) => {
        const step = stepOf(batch, stepId);
        const attempt = Math.max(...step.attempts.keys());
        return {
          ...batch,
          steps: put(batch.steps, stepId, {
            ...step,
            inputs: [...step.inputs, { by, via, answers, attempt }],
          }),
        };
      });
    }
    case 'batch.stuck': {
      const { reason, options, remindAt } = event;
      return updateBatch(state, event.batchId, (batch) => ({
        ...batch,
        lane: { kind: 'stuck', reason, options, remindAt },
        steps: abandon(batch.steps),
      }));
    }
    case 'batch.resumed': {
      // A retry of a batch Stuck on routing waits to be routed again (ADR 0032).
      const resumed = setLane(
        state,
        event.batchId,
        event.routeBy === undefined
          ? { kind: 'brewing' }
          : { kind: 'ordered', routeBy: event.routeBy },
      );
      // A skip of a batch Stuck on its pull request's checks leaves that head as it is (ADR 0219).
      const lane = state.batches.get(event.batchId)?.lane;
      if (
        event.action !== 'skip' ||
        lane?.kind !== 'stuck' ||
        lane.reason.kind !== 'pull_request_failed'
      ) {
        return resumed;
      }
      const { pullRequest, head } = lane.reason;
      return updateBatch(resumed, event.batchId, (batch) => ({
        ...batch,
        pullRequestLeft: { pullRequest, head },
      }));
    }
    case 'order.decomposed': {
      const { id, issue, repo } = batchOf(state, event.batchId);
      // Sub-orders are Brewery issues, split from a Brewery order (ADR 0043).
      if (repo !== undefined) {
        throw reject(
          `batch ${id} brews issue ${issue} of ${repo}; only a Brewery order can be decomposed`,
        );
      }
      // One level of breakdown (architecture §3.2, ADR 0013).
      if (state.subOrders.has(issue)) {
        throw reject(`batch ${id} brews sub-order ${issue}; only an order can be decomposed`);
      }
      const listed = new Set(event.subOrders.map((subOrder) => subOrder.issue));
      const subOrders = new Map(state.subOrders);
      // Sub-orders the new breakdown leaves out are cancelled, never deleted (ADR 0014); they
      // keep their batches.
      for (const [subIssue, subOrder] of state.subOrders) {
        if (subOrder.order === issue && !listed.has(subIssue)) {
          subOrders.set(subIssue, { ...subOrder, cancelled: true });
        }
      }
      for (const { issue: subIssue, repo, touches, entry } of event.subOrders) {
        if (state.orders.has(subIssue)) {
          throw reject(`issue ${subIssue} is an order, so it cannot be a sub-order`);
        }
        const earlier = state.subOrders.get(subIssue);
        if (earlier !== undefined && earlier.order !== issue) {
          throw reject(`sub-order ${subIssue} already belongs to order ${earlier.order}`);
        }
        subOrders.set(subIssue, {
          issue: subIssue,
          repo,
          ...(touches === undefined ? {} : { touches }),
          order: issue,
          batchIds: earlier?.batchIds ?? [],
          cancelled: false,
          ...(entry === undefined || event.plan === undefined
            ? {}
            : { plan: { batchId: event.batchId, ...event.plan, entry } }),
        });
      }
      const decomposed = updateBatch(state, event.batchId, (batch) => ({
        ...batch,
        decomposed: true as const,
      }));
      return {
        ...decomposed,
        orders: put(state.orders, issue, {
          ...orderOf(state, issue),
          subOrders: event.subOrders.map((subOrder) => subOrder.issue),
          dependencies: event.dependencies,
        }),
        subOrders,
      };
    }
    case 'order.ranked': {
      const { order, place, by, via, why } = event;
      const seq = 1 + Math.max(0, ...[...state.ranks.values()].map((rank) => rank.seq));
      const rank: Rank = { order, place, seq, by, via, ...(why === undefined ? {} : { why }) };
      // A later rank of the same order replaces the earlier one (ADR 0208).
      return { ...state, ranks: put(state.ranks, orderKey(order), rank) };
    }
    case 'batch.waiting': {
      const { on, remindAt } = event;
      return setLane(state, event.batchId, { kind: 'conditioning', on, remindAt });
    }
    case 'bottle.opened': {
      const { bottleId: id, repo, subOrders, pullRequest } = event;
      if (state.bottles.has(id)) throw reject(`bottle ${id} was already opened`);
      return { ...state, bottles: put(state.bottles, id, { id, repo, subOrders, pullRequest }) };
    }
    case 'release.observed': {
      const { repo, package: name, version } = event;
      const release = { repo, package: name, version, seq: nextPosition(state) };
      return { ...state, releases: [...state.releases, release] };
    }
    case 'batch.rewound': {
      const { batchId, toStepId, by, via, shas } = event;
      return updateBatch(state, batchId, (batch) => {
        stepOf(batch, toStepId);
        return {
          ...batch,
          lane: { kind: 'brewing' },
          rewinds: [...batch.rewinds, { toStepId, by, via, shas }],
          taskTree: { kind: 'rewound', shas },
        };
      });
    }
    case 'batch.approved': {
      const { batchId, stepId, attempt, plan, by, via, at } = event;
      // The decider puts it on tap in the same decision (ADR 0281).
      return updateBatch(setLane(state, batchId, { kind: 'brewing' }), batchId, (batch) => ({
        ...batch,
        approval: { stepId, attempt, plan, by, via, at },
      }));
    }
    case 'batch.on_tap':
      return setLane(state, event.batchId, { kind: 'on_tap', pullRequests: event.pullRequests });
    case 'batch.taken_over': {
      const { by, via, from, to, until, resumes } = event;
      return updateBatch(state, event.batchId, (batch) => ({
        ...batch,
        takeover: { by, via, from, to, until, ...(resumes === undefined ? {} : { resumes }) },
      }));
    }
    case 'batch.cancelled':
      return setLane(state, event.batchId, { kind: 'cancelled', by: event.by, via: event.via });
    case 'pull_request.ended': {
      const { batchId, pullRequest, state: end } = event;
      const ended = updateBatch(state, batchId, (batch) => {
        if (batch.pullRequestEnds?.[pullRequest] !== undefined) {
          throw reject(`pull request ${pullRequest} of batch ${batchId} already ended`);
        }
        return { ...batch, pullRequestEnds: { ...batch.pullRequestEnds, [pullRequest]: end } };
      });
      // A bottle's pull request is recorded merged by each batch it bottles: the first counts.
      if (end === 'closed' || ended.merges.has(pullRequest)) return ended;
      return { ...ended, merges: put(ended.merges, pullRequest, nextPosition(state)) };
    }
    case 'pull_request.base_checked': {
      const { batchId, pullRequest, branch, tip, head, conflicts, branchMoved, failed, unchecked } =
        event;
      const check: BaseCheck = {
        pullRequest,
        branch,
        tip,
        ...(head === undefined ? {} : { head }),
        ...(conflicts === undefined ? {} : { conflicts }),
        ...(branchMoved === undefined ? {} : { branchMoved }),
        ...(failed === undefined ? {} : { failed }),
        ...(unchecked === undefined ? {} : { unchecked }),
      };
      return updateBatch(state, batchId, (batch) => ({
        ...batch,
        baseChecks: [...(batch.baseChecks ?? []), check],
      }));
    }
    case 'pull_request.pair_checked': {
      const { batchId, pullRequest, head, other, otherHead, conflicts } = event;
      const check: PairCheck = {
        pullRequest,
        head,
        otherHead,
        ...(conflicts === undefined ? {} : { conflicts }),
      };
      // The latest record per other pull request: an older pair of heads says nothing now.
      return updateBatch(state, batchId, (batch) => ({
        ...batch,
        pairChecks: { ...batch.pairChecks, [other]: check },
      }));
    }
    case 'pull_request.checks_pending': {
      const { batchId, pullRequest, head, since } = event;
      return updateBatch(state, batchId, (batch) => ({
        ...batch,
        pullRequestChecks: {
          ...batch.pullRequestChecks,
          [pullRequest]: { kind: 'pending', head, since },
        },
      }));
    }
    case 'pull_request.checks_finished': {
      const { batchId, pullRequest, head, checks, more } = event;
      return updateBatch(state, batchId, (batch) => ({
        ...batch,
        pullRequestChecks: {
          ...batch.pullRequestChecks,
          [pullRequest]: {
            kind: 'finished',
            head,
            checks,
            ...(more === undefined ? {} : { more }),
          },
        },
      }));
    }
    case 'order.paused': {
      const { order, by, via, why, stopAt, zone } = event;
      const pause: Pause = {
        by,
        via,
        ...(why === undefined ? {} : { why }),
        ...(stopAt === undefined || zone === undefined ? {} : { stopAt: { at: stopAt, zone } }),
      };
      const { pauses } = state;
      // A later pause of the same order, or a later --all, replaces the earlier one (ADR 0202).
      return {
        ...state,
        pauses:
          order === undefined
            ? { ...pauses, all: pause }
            : { ...pauses, orders: put(pauses.orders, orderKey(order), pause) },
      };
    }
    case 'order.continued': {
      const { order } = event;
      const { pauses } = state;
      // --all lifts every pause (ADR 0202).
      if (order === undefined) {
        if (pauses.all === undefined && pauses.orders.size === 0) throw reject('nothing is paused');
        return { ...state, pauses: { orders: new Map() } };
      }
      const key = orderKey(order);
      if (!pauses.orders.has(key)) throw reject(`order ${key} is not paused`);
      const orders = new Map(pauses.orders);
      orders.delete(key);
      return { ...state, pauses: { ...pauses, orders } };
    }
    case 'step.rescheduled': {
      const { batchId, stepId, attempt, deadlineAt } = event;
      return updateBatch(state, batchId, (batch) => {
        const step = stepOf(batch, stepId);
        const current = step.attempts.get(attempt);
        if (current === undefined) throw attemptError(event, 'was never scheduled');
        if (current.phase !== 'scheduled' || current.abandoned === true) {
          throw attemptError(event, 'is not waiting to start');
        }
        return {
          ...batch,
          steps: put(batch.steps, stepId, {
            ...step,
            attempts: put(step.attempts, attempt, { ...current, deadlineAt }),
          }),
        };
      });
    }
    case 'usage.window_closed': {
      // A later limit replaces the window of its scope: decide keeps the later reopen (ADR 0206).
      // The limit names the scope, also in a log written before scopes (ADR 0215).
      const { limit, resets, reopensAt, read } = event;
      const window = { limit, resets, reopensAt, read };
      return { ...state, usageWindows: { ...state.usageWindows, [scopeOf(limit)]: window } };
    }
    case 'usage.window_opened': {
      const { scope } = event;
      // Without a scope, as #543 wrote it, every closed window opened (ADR 0215).
      if (scope === undefined) {
        if (Object.keys(state.usageWindows).length === 0) {
          throw reject('the usage window is not closed');
        }
        return { ...state, usageWindows: {} };
      }
      if (state.usageWindows[scope] === undefined) {
        throw reject(`the ${scope === 'all' ? '' : `${scope} `}usage window is not closed`);
      }
      const { [scope]: _opened, ...closed } = state.usageWindows;
      return { ...state, usageWindows: closed };
    }
    case 'effect.applied': {
      // Invariant I4: an effect is keyed by a batch or an attempt of the log (ADR 0043), and
      // applied at most once.
      const key = effectKey.decode(event.key);
      const batch = batchOf(state, key.batchId);
      if ('stepId' in key && !batch.steps.get(key.stepId)?.attempts.has(key.attempt)) {
        throw attemptError(key, 'was never scheduled');
      }
      if (state.effects.has(event.key)) {
        throw reject(`effect ${event.key} was already applied`);
      }
      return { ...state, effects: put(state.effects, event.key, event.result) };
    }
    default:
      return unreachable(event);
  }
}

type AttemptEvent = Extract<Event, { type: 'step.started' | 'step.finished' }>;

const put = <K, V>(map: ReadonlyMap<K, V>, key: K, value: V): ReadonlyMap<K, V> =>
  new Map(map).set(key, value);

const reject = (reason: string): Rejection => new Rejection(reason);

const attemptError = (
  { batchId, stepId, attempt }: Pick<AttemptEvent, 'batchId' | 'stepId' | 'attempt'>,
  what: string,
): Rejection => reject(`attempt ${stepId}#${attempt} of batch ${batchId} ${what}`);

/** The order of an issue, or a new one when it has no batches yet. */
const orderOf = (state: State, issue: number): Order =>
  state.orders.get(issue) ?? { issue, batchIds: [], subOrders: [], dependencies: [] };

function batchOf(state: State, batchId: string): Batch {
  const batch = state.batches.get(batchId);
  if (batch === undefined) throw reject(`batch ${batchId} was never ordered`);
  return batch;
}

function stepOf(batch: Batch, stepId: string): Step {
  const step = batch.steps.get(stepId);
  if (step === undefined) {
    throw reject(`step ${stepId} of batch ${batch.id} was never scheduled`);
  }
  return step;
}

/** `batch` with `stepId` added to or taken out of its skipped steps; none is kept as absent. */
function skipping(batch: Batch, stepId: string, skipped: boolean): Batch {
  const steps = new Set(batch.skipped);
  if (skipped) steps.add(stepId);
  else steps.delete(stepId);
  const { skipped: _, ...rest } = batch;
  return steps.size === 0 ? rest : { ...rest, skipped: steps };
}

function updateBatch(state: State, batchId: string, update: (batch: Batch) => Batch): State {
  return { ...state, batches: put(state.batches, batchId, update(batchOf(state, batchId))) };
}

function setLane(state: State, batchId: string, lane: Lane): State {
  return updateBatch(state, batchId, (batch) => ({ ...batch, lane }));
}

/**
 * `batch` started at `commit` in `repo` unless it has a start there already: its first attempt
 * there, until the first that succeeded replaces it (ADR 0084).
 */
const startAt = (
  batch: Batch,
  { repo, commit }: { repo: string; commit: string },
  succeeded: boolean,
): Batch => {
  const key = repo.toLowerCase();
  const current = batch.starts?.[key];
  if (current !== undefined && (current.succeeded || !succeeded)) return batch;
  return { ...batch, starts: { ...batch.starts, [key]: { commit, succeeded } } };
};

function updateAttempt(
  state: State,
  event: AttemptEvent,
  update: (attempt: Attempt, step: Step) => Attempt,
): State {
  return updateBatch(state, event.batchId, (batch) => {
    const step = batch.steps.get(event.stepId);
    const attempt = step?.attempts.get(event.attempt);
    if (step === undefined || attempt === undefined) {
      throw attemptError(event, 'was never scheduled');
    }
    return {
      ...batch,
      steps: put(batch.steps, step.id, {
        ...step,
        attempts: put(step.attempts, event.attempt, update(attempt, step)),
      }),
    };
  });
}

/** Marks every attempt that has not finished as abandoned. */
function abandon(steps: ReadonlyMap<string, Step>): ReadonlyMap<string, Step> {
  const abandoned = new Map<string, Step>();
  for (const [id, step] of steps) {
    const attempts = new Map<number, Attempt>();
    for (const [number, attempt] of step.attempts) {
      attempts.set(
        number,
        attempt.phase === 'finished' ? attempt : { ...attempt, abandoned: true },
      );
    }
    abandoned.set(id, { ...step, attempts });
  }
  return abandoned;
}

function unreachable(event: never): never {
  throw new Error(`Unhandled event: ${JSON.stringify(event)}`);
}
