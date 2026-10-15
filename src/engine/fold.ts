// The fold: current state from the event log (architecture §4.1, invariant I3).
// Pure: no clock, randomness or I/O, and neither the events nor the state passed in are changed.

import type {
  Answer,
  Dependency,
  Event,
  SessionRef,
  StuckOption,
  StuckReason,
  Surface,
  Usage,
  WaitCondition,
} from '../schemas/events.ts';
import type { StepOutcome } from '../schemas/step-outcome.ts';

/** Where a batch is: the board lanes (architecture §4.3), plus cancelled. */
export type Lane =
  | { kind: 'ordered' }
  | { kind: 'brewing' }
  | { kind: 'conditioning'; on: WaitCondition; remindAt: string }
  | { kind: 'stuck'; reason: StuckReason; options: readonly StuckOption[] }
  | { kind: 'on_tap'; pullRequests: readonly string[] }
  | { kind: 'cancelled'; by: string };

export type Attempt =
  | { phase: 'scheduled'; attempt: number; deadlineAt: string }
  | { phase: 'started'; attempt: number; deadlineAt: string; session?: SessionRef }
  | {
      phase: 'finished';
      attempt: number;
      deadlineAt: string;
      session?: SessionRef;
      outcome: StepOutcome;
      usage?: Usage;
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
  shas: Readonly<Record<string, string>>;
}

export interface Batch {
  id: string;
  /** The issue this batch brews: an order or a sub-order. */
  issue: number;
  parentBatchId?: string;
  recipe?: { name: string; reason: string; by: 'label' | 'router' | 'human' };
  lane: Lane;
  steps: ReadonlyMap<string, Step>;
  rewinds: readonly Rewind[];
}

/** A Brewery issue with batches: an order or a sub-order. */
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
 * Folds `events` onto `state`; `fold(rest, fold(prefix))` equals `fold([...prefix, ...rest])`.
 * Throws when an event refers to a batch, step or attempt the log never created.
 */
export function fold(events: readonly Event[], state: State = emptyState): State {
  return events.reduce(apply, state);
}

function apply(state: State, event: Event): State {
  switch (event.type) {
    case 'batch.ordered': {
      const { batchId, order, parentBatchId } = event;
      if (state.batches.has(batchId)) throw inconsistent(`batch ${batchId} was already ordered`);
      if (parentBatchId !== undefined) batchOf(state, parentBatchId);
      const existing = orderOf(state, order.issue);
      return {
        ...state,
        orders: put(state.orders, order.issue, {
          ...existing,
          batchIds: [...existing.batchIds, batchId],
        }),
        batches: put(state.batches, batchId, {
          id: batchId,
          issue: order.issue,
          ...(parentBatchId === undefined ? {} : { parentBatchId }),
          lane: { kind: 'ordered' },
          steps: new Map(),
          rewinds: [],
        }),
      };
    }
    case 'batch.recipe_chosen': {
      const { recipe: name, reason, by } = event;
      return updateBatch(state, event.batchId, (batch) => ({
        ...batch,
        recipe: { name, reason, by },
      }));
    }
    case 'step.scheduled': {
      const { batchId, stepId, attempt, deadlineAt } = event;
      return updateBatch(state, batchId, (batch) => {
        const step = batch.steps.get(stepId) ?? { id: stepId, attempts: new Map(), inputs: [] };
        if (step.attempts.has(attempt)) {
          throw inconsistent(
            `attempt ${stepId}#${attempt} of batch ${batchId} was already scheduled`,
          );
        }
        return {
          ...batch,
          lane: { kind: 'brewing' },
          steps: put(batch.steps, stepId, {
            ...step,
            attempts: put(step.attempts, attempt, { phase: 'scheduled', attempt, deadlineAt }),
          }),
        };
      });
    }
    case 'step.started':
      return updateAttempt(state, event, (current) => {
        return {
          phase: 'started',
          attempt: current.attempt,
          deadlineAt: current.deadlineAt,
          ...(event.session === undefined ? {} : { session: event.session }),
        };
      });
    case 'step.finished':
      return updateAttempt(state, event, (current) => {
        if (current.phase === 'scheduled') throw attemptError(event, 'was never started');
        return {
          ...current,
          phase: 'finished',
          outcome: event.outcome,
          ...(event.usage === undefined ? {} : { usage: event.usage }),
        };
      });
    case 'input.received': {
      const { by, via, answers } = event;
      return updateStep(state, event.batchId, event.stepId, (step) => ({
        ...step,
        inputs: [...step.inputs, { by, via, answers }],
      }));
    }
    case 'batch.stuck': {
      const { reason, options } = event;
      return setLane(state, event.batchId, { kind: 'stuck', reason, options });
    }
    case 'batch.resumed':
      return setLane(state, event.batchId, { kind: 'brewing' });
    case 'order.decomposed': {
      const { issue } = batchOf(state, event.batchId);
      const subOrders = new Map(
        [...state.subOrders].filter(([, subOrder]) => subOrder.order !== issue),
      );
      for (const { issue: subIssue, repo } of event.subOrders) {
        subOrders.set(subIssue, { issue: subIssue, repo, order: issue });
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
      return { ...state, bottles: put(state.bottles, id, { id, repo, subOrders, pullRequest }) };
    }
    case 'release.observed': {
      const { repo, package: name, version } = event;
      return { ...state, releases: [...state.releases, { repo, package: name, version }] };
    }
    case 'batch.rewound': {
      const { batchId, toStepId, by, shas } = event;
      return updateBatch(state, batchId, (batch) => {
        stepOf(batch, toStepId);
        return {
          ...batch,
          lane: { kind: 'brewing' },
          rewinds: [...batch.rewinds, { toStepId, by, shas }],
        };
      });
    }
    case 'batch.on_tap':
      return setLane(state, event.batchId, { kind: 'on_tap', pullRequests: event.pullRequests });
    case 'batch.cancelled':
      return setLane(state, event.batchId, { kind: 'cancelled', by: event.by });
    case 'effect.applied':
      return { ...state, effects: put(state.effects, event.key, event.result) };
    default:
      return unreachable(event);
  }
}

type AttemptEvent = Extract<Event, { type: 'step.started' | 'step.finished' }>;

const put = <K, V>(map: ReadonlyMap<K, V>, key: K, value: V): ReadonlyMap<K, V> =>
  new Map(map).set(key, value);

const inconsistent = (message: string): Error => new Error(`Inconsistent event log: ${message}`);

const attemptError = ({ batchId, stepId, attempt }: AttemptEvent, what: string): Error =>
  inconsistent(`attempt ${stepId}#${attempt} of batch ${batchId} ${what}`);

/** The order of an issue, or a new one when it has no batches yet. */
const orderOf = (state: State, issue: number): Order =>
  state.orders.get(issue) ?? { issue, batchIds: [], subOrders: [], dependencies: [] };

function batchOf(state: State, batchId: string): Batch {
  const batch = state.batches.get(batchId);
  if (batch === undefined) throw inconsistent(`batch ${batchId} was never ordered`);
  return batch;
}

function stepOf(batch: Batch, stepId: string): Step {
  const step = batch.steps.get(stepId);
  if (step === undefined) {
    throw inconsistent(`step ${stepId} of batch ${batch.id} was never scheduled`);
  }
  return step;
}

function updateBatch(state: State, batchId: string, update: (batch: Batch) => Batch): State {
  return { ...state, batches: put(state.batches, batchId, update(batchOf(state, batchId))) };
}

function setLane(state: State, batchId: string, lane: Lane): State {
  return updateBatch(state, batchId, (batch) => ({ ...batch, lane }));
}

function updateStep(
  state: State,
  batchId: string,
  stepId: string,
  update: (step: Step) => Step,
): State {
  return updateBatch(state, batchId, (batch) => ({
    ...batch,
    steps: put(batch.steps, stepId, update(stepOf(batch, stepId))),
  }));
}

function updateAttempt(
  state: State,
  event: AttemptEvent,
  update: (attempt: Attempt) => Attempt,
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
        attempts: put(step.attempts, event.attempt, update(attempt)),
      }),
    };
  });
}

function unreachable(event: never): never {
  throw new Error(`Unhandled event: ${JSON.stringify(event)}`);
}
