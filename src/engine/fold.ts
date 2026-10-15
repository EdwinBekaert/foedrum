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

/** Folds `events` onto `state`; `fold(rest, fold(prefix))` equals `fold([...prefix, ...rest])`. */
export function fold(_events: readonly Event[], _state: State = emptyState): State {
  throw new Error('not implemented');
}
