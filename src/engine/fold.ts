// The fold: current state from the event log (architecture §4.1, invariant I3).
// Pure: no clock, randomness or I/O, and neither the events nor the state passed in are changed.

import type {
  Answer,
  ClaudeReport,
  Dependency,
  Event,
  GravityReading,
  ScheduleRoute,
  SessionRef,
  StuckOption,
  StuckReason,
  Surface,
  Usage,
  WaitCondition,
  WorktreeRef,
} from '../schemas/events.ts';
import type { StepOutcome } from '../schemas/step-outcome.ts';
import { effectKey } from './effect-key.ts';
import { ranIn } from './session-resume.ts';

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
      abandoned?: true;
    }
  | {
      phase: 'started';
      attempt: number;
      deadlineAt: string;
      route?: ScheduleRoute;
      /** Scheduled because the attempt before it failed (ADR 0117). */
      retry?: true;
      session?: SessionRef;
      worktree?: WorktreeRef;
      abandoned?: true;
    }
  | {
      phase: 'finished';
      attempt: number;
      deadlineAt: string;
      route?: ScheduleRoute;
      /** Scheduled because the attempt before it failed (ADR 0117). */
      retry?: true;
      session?: SessionRef;
      worktree?: WorktreeRef;
      outcome: StepOutcome;
      usage?: Usage;
      /** A check step's gravity readings (ADR 0069). */
      readings?: readonly GravityReading[];
      /** What claude reported in its init event, when it came (ADR 0116). */
      claude?: ClaudeReport;
    };

export interface Input {
  by: string;
  via: Surface;
  answers: readonly Answer[];
}

export interface Step {
  id: string;
  /** By attempt number. */
  attempts: ReadonlyMap<number, Attempt>;
  inputs: readonly Input[];
}

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
  /** What chose the recipe; a human's choice also records who issued it and from where. */
  recipe?: { name: string; reason: string } & (
    | { source: 'label' | 'router' }
    | { source: 'human'; by: string; via: Surface }
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
  /** The order it was split from. */
  order: number;
  batchIds: readonly string[];
  /** Left out of the order's latest breakdown; a later breakdown that lists it again un-cancels it. */
  cancelled: boolean;
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
}

export interface State {
  orders: ReadonlyMap<number, Order>;
  subOrders: ReadonlyMap<number, SubOrder>;
  batches: ReadonlyMap<string, Batch>;
  bottles: ReadonlyMap<string, Bottle>;
  releases: readonly Release[];
  /** The idempotency ledger: result by effect key (invariant I4). */
  effects: ReadonlyMap<string, unknown>;
}

export const emptyState: State = {
  orders: new Map(),
  subOrders: new Map(),
  batches: new Map(),
  bottles: new Map(),
  releases: [],
  effects: new Map(),
};

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
      const { batchId, order, parentBatchId, routeBy } = event;
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
        lane: { kind: 'ordered', routeBy },
        steps: new Map(),
        rewinds: [],
      });
      // A claimed target issue is an order, but `orders` and `subOrders` hold the Brewery's own
      // issues by number, which its number would collide with (ADR 0050).
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
            ? { name, reason, source: event.source, by: event.by, via: event.via }
            : { name, reason, source: event.source },
      }));
    }
    case 'step.scheduled': {
      const { batchId, stepId, attempt, deadlineAt, route, retry } = event;
      return updateBatch(state, batchId, (batch) => {
        const step = batch.steps.get(stepId) ?? { id: stepId, attempts: new Map(), inputs: [] };
        if (step.attempts.has(attempt)) throw attemptError(event, 'was already scheduled');
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
        };
      });
      const { worktree } = event;
      if (worktree === undefined) return next;
      return updateBatch(next, event.batchId, (batch) => startAt(batch, worktree, false));
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
        return {
          ...batch,
          steps: put(batch.steps, stepId, {
            ...step,
            inputs: [...step.inputs, { by, via, answers }],
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
    case 'batch.resumed':
      // A retry of a batch Stuck on routing waits to be routed again (ADR 0032).
      return setLane(
        state,
        event.batchId,
        event.routeBy === undefined
          ? { kind: 'brewing' }
          : { kind: 'ordered', routeBy: event.routeBy },
      );
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
      for (const { issue: subIssue, repo } of event.subOrders) {
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
          order: issue,
          batchIds: earlier?.batchIds ?? [],
          cancelled: false,
        });
      }
      return {
        ...state,
        orders: put(state.orders, issue, {
          ...orderOf(state, issue),
          subOrders: event.subOrders.map((subOrder) => subOrder.issue),
          dependencies: event.dependencies,
        }),
        subOrders,
      };
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
      return { ...state, releases: [...state.releases, { repo, package: name, version }] };
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
    case 'batch.on_tap':
      return setLane(state, event.batchId, { kind: 'on_tap', pullRequests: event.pullRequests });
    case 'batch.taken_over': {
      const { by, via, from, to, until } = event;
      return updateBatch(state, event.batchId, (batch) => ({
        ...batch,
        takeover: { by, via, from, to, until },
      }));
    }
    case 'batch.cancelled':
      return setLane(state, event.batchId, { kind: 'cancelled', by: event.by, via: event.via });
    case 'pull_request.ended': {
      const { batchId, pullRequest, state: end } = event;
      return updateBatch(state, batchId, (batch) => {
        if (batch.pullRequestEnds?.[pullRequest] !== undefined) {
          throw reject(`pull request ${pullRequest} of batch ${batchId} already ended`);
        }
        return { ...batch, pullRequestEnds: { ...batch.pullRequestEnds, [pullRequest]: end } };
      });
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
