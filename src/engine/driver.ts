// A driver (ADR 0019): the Cellar or an interactive session. It takes its lock and starts on the
// store before any work (ADR 0037), holds the lease of every batch it drives and renews it on every
// tick (the driver, never the brewer runner), starts the scheduled attempts of those batches on a
// brewer runner, finishes them as they end, runs the supervisor over its own batches and the free
// ones, and applies a batch's effects only while it holds the batch's lease (ADR 0033).

import type { AttemptWorktrees, CleanReport } from '../workspace/attempt-worktrees-git.ts';
import type { AttemptLimits, BrewerRunner } from './brewer-runner.ts';
import type { DriverLock } from './driver-lock.ts';
import type { DriverStart } from './driver-start.ts';
import type { EffectTarget } from './effects.ts';
import type { BatchLease, EffectKey, EventStore } from './event-store.ts';
import type { State } from './fold.ts';
import type { Recipes } from './recipes.ts';
import type { StateBranch } from './state-branch-git.ts';
import type { Notice } from './supervisor-loop.ts';

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

/**
 * Takes the driver's lock and starts it on the store (`startDriver`), then returns it. Rejects,
 * letting the lock go, when the start fails; nothing is driven before it.
 */
export const openDriver = async (_options: DriverOptions): Promise<Driver> => {
  throw new Error('not implemented');
};
