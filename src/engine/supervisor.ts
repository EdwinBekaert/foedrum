// The supervisor's pure core (architecture §4.4, ADR 0025, ADR 0027): from the folded state, the
// due deadlines and the expired leases, the engine commands one tick issues. It never builds events:
// decide does, so the supervisor cannot do what the state machine refuses.

import { type AttemptRef, attemptKey } from './attempt-key.ts';
import type { EngineCommand } from './decide.ts';
import type { DueBatch, Lease } from './event-store.ts';
import type { Batch, State } from './fold.ts';
import type { Recipes, Stall } from './recipes.ts';
import type { FlushResult } from './state-branch-git.ts';

/** What the runner (#11) knows about a running attempt: when it last wrote a file or committed. */
export interface AttemptProgress {
  lastProgressAt: Date;
  /** Turns since then. */
  turnsWithoutProgress: number;
}

/** The runner's progress signals; `undefined` for an attempt it does not run. */
export interface ProgressSource {
  progress(attempt: AttemptRef): AttemptProgress | undefined;
}

export interface TickInput {
  state: State;
  /** The batches whose pending deadline is due (`EventStore.batchesPastDeadline(now)`). */
  due: readonly DueBatch[];
  /** The leases that expired (`EventStore.expiredLeases(now)`). */
  expiredLeases: readonly Lease[];
  progress: ProgressSource;
  recipes: Recipes;
  now: Date;
}

/** An engine command about one batch. */
type BatchCommand = Extract<EngineCommand, { batchId: string }>;

export interface TickPlan {
  /** At most one per batch, to decide in this order. */
  commands: BatchCommand[];
  /** Every expired lease: its attempt is lost, or no longer runs. */
  releaseLeases: string[];
}

/** The commands one tick issues: deadlines first (invariant I5), then lost, then stalled attempts. */
export const planTick = (input: TickInput): TickPlan => {
  const { state, due, expiredLeases, progress, recipes, now } = input;
  // One command per batch: the first one decided makes the others moot.
  const commands = new Map<string, BatchCommand>();
  const issue = (command: BatchCommand | undefined): void => {
    if (command !== undefined && !commands.has(command.batchId)) {
      commands.set(command.batchId, command);
    }
  };
  for (const { batchId } of due) {
    const batch = state.batches.get(batchId);
    if (batch !== undefined) issue(dueCommand(batch, now));
  }
  for (const { attemptKey: key, owner, expiresAt } of expiredLeases) {
    const ref = attemptKey.decode(key);
    const batch = ref && state.batches.get(ref.batchId);
    const lost = batch && running(batch).find((attempt) => isSame(attempt, ref));
    if (lost?.phase === 'started') {
      const reason = `the lease of ${owner} expired at ${expiresAt.toISOString()}`;
      issue({
        kind: 'lose',
        batchId: lost.batchId,
        stepId: lost.stepId,
        attempt: lost.attempt,
        reason,
      });
    }
  }
  for (const batch of state.batches.values()) {
    if (commands.has(batch.id)) continue;
    const recipe = batch.recipe && recipes.find(batch.recipe.name);
    for (const { phase, batchId, stepId, attempt } of running(batch)) {
      // A step the recipe file no longer has (renamed under the batch) has no stall limit: its
      // deadline still holds, and asking the recipe about it would throw on every tick.
      const limit = recipe?.has(stepId) === true ? recipe.stall(stepId) : undefined;
      const signal =
        phase === 'started' ? progress.progress({ batchId, stepId, attempt }) : undefined;
      if (limit !== undefined && signal !== undefined && isStalled(limit, signal, now)) {
        const { lastProgressAt, turnsWithoutProgress } = signal;
        issue({ kind: 'stall', batchId, stepId, attempt, lastProgressAt, turnsWithoutProgress });
      }
    }
  }
  return {
    commands: [...commands.values()],
    releaseLeases: expiredLeases.map((lease) => lease.attemptKey),
  };
};

/** What a due deadline asks of `batch`: expire, remind (ADR 0025) or `unrouted` (ADR 0032). */
function dueCommand(batch: Batch, now: Date): BatchCommand | undefined {
  const { lane } = batch;
  const isDue = (at: string): boolean => Date.parse(at) <= now.getTime();
  switch (lane.kind) {
    case 'brewing': {
      const [late] = running(batch)
        .filter((attempt) => isDue(attempt.deadlineAt))
        .sort((a, b) => Date.parse(a.deadlineAt) - Date.parse(b.deadlineAt));
      return (
        late && { kind: 'expire', batchId: batch.id, stepId: late.stepId, attempt: late.attempt }
      );
    }
    case 'ordered':
      return isDue(lane.routeBy) ? { kind: 'unrouted', batchId: batch.id } : undefined;
    case 'conditioning':
    case 'stuck':
      return isDue(lane.remindAt) ? { kind: 'remind', batchId: batch.id } : undefined;
    case 'on_tap':
    case 'cancelled':
      return undefined;
    default: {
      const unhandled: never = lane;
      throw new Error(`Unhandled lane ${JSON.stringify(unhandled)}`);
    }
  }
}

type Running = AttemptRef & { phase: 'scheduled' | 'started'; deadlineAt: string };

/** The attempts of a brewing batch that run: each the latest of its step, neither finished nor abandoned. */
function running(batch: Batch): Running[] {
  if (batch.lane.kind !== 'brewing') return [];
  const result: Running[] = [];
  for (const [stepId, step] of batch.steps) {
    const latest = step.attempts.get(Math.max(...step.attempts.keys()));
    if (latest !== undefined && latest.phase !== 'finished' && latest.abandoned !== true) {
      const { phase, attempt, deadlineAt } = latest;
      result.push({ batchId: batch.id, stepId, attempt, phase, deadlineAt });
    }
  }
  return result;
}

const isSame = (a: AttemptRef, b: AttemptRef): boolean =>
  a.stepId === b.stepId && a.attempt === b.attempt;

const isStalled = (limit: Stall, signal: AttemptProgress, now: Date): boolean =>
  (limit.turns !== undefined && signal.turnsWithoutProgress >= limit.turns) ||
  (limit.minutes !== undefined &&
    now.getTime() - signal.lastProgressAt.getTime() >= limit.minutes * 60_000);

/** Since when flushes of the state branch fail, and whether that was already reported. */
export type FlushWatch = { failingSince: Date; reported: boolean } | undefined;

/**
 * Follows the state branch's flushes: `overdueSince` is set once, on the first flush that still
 * fails `deadlineMs` after the first failure, so the engine raises attention once (ADR 0024 as amended by ADR 0027).
 */
export const watchFlush = (
  watch: FlushWatch,
  outcome: FlushResult['kind'],
  now: Date,
  deadlineMs: number,
): { watch: FlushWatch; overdueSince?: Date } => {
  if (outcome !== 'failed') return { watch: undefined };
  if (watch === undefined) return { watch: { failingSince: now, reported: false } };
  if (!watch.reported && now.getTime() - watch.failingSince.getTime() >= deadlineMs) {
    return { watch: { ...watch, reported: true }, overdueSince: watch.failingSince };
  }
  return { watch };
};
