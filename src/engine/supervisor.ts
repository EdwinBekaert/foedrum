// The supervisor's pure core (architecture §4.4, ADR 0025, ADR 0027): from the folded state, the
// due deadlines and the expired leases, the engine commands one tick issues. It never builds events:
// decide does, so the supervisor cannot do what the state machine refuses.

import { type AttemptRef, attemptKey } from './attempt-key.ts';
import type { EngineCommand } from './decide.ts';
import type { DueBatch, Lease } from './event-store.ts';
import { type Batch, runningAttempt, type State } from './fold.ts';
import { pauseOf } from './pauses.ts';
import { causeOf, fixHeld, pullRequestProblem, pullRequestRoute } from './pull-request-fix.ts';
import type { Recipes, Stall } from './recipes.ts';
import type { FlushResult } from './state-branch-git.ts';

/** What the runner (#11) knows about a running attempt: when it last wrote a file or committed. */
export interface AttemptProgress {
  lastProgressAt: Date;
  /** Turns since then. */
  turnsWithoutProgress: number;
  /** For display (ADR 0174): the main thread's turns so far; a brewer's attempt only. */
  turn?: number;
  /** For display: the latest main-thread tool call, reduced to its name and one safe word. */
  lastTool?: { name: string; word?: string };
  /** For display: whether a denial came after the latest main-thread tool call. */
  denied?: boolean;
  /** For display: whether the repository's setup runs, before claude starts. */
  settingUp?: boolean;
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
  /** Every expired lease but those of lost attempts it leaves to the next tick (ADR 0168). */
  releaseLeases: string[];
  /** A closed usage window's reopen is due, before the batches' commands (ADR 0206, ADR 0215). */
  reopen?: true;
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
    if (batch !== undefined) issue(dueCommand(state, batch, now, recipes));
  }
  // The expired leases of lost attempts this tick leaves to the next: a batch's other children
  // of a parallel group, which would otherwise wait out their deadline with no lease (ADR 0168).
  const kept = new Set<string>();
  for (const { attemptKey: key, owner, expiresAt } of expiredLeases) {
    const ref = attemptKey.decode(key);
    const batch = ref && state.batches.get(ref.batchId);
    const lost = batch && running(batch).find((attempt) => isSame(attempt, ref));
    if (lost?.phase !== 'started') continue;
    if (commands.get(lost.batchId)?.kind === 'lose') {
      kept.add(key);
      continue;
    }
    const reason = `the lease of ${owner} expired at ${expiresAt.toISOString()}`;
    issue({
      kind: 'lose',
      batchId: lost.batchId,
      stepId: lost.stepId,
      attempt: lost.attempt,
      reason,
    });
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
  // A batch on tap whose pull request failed on the head it pushed goes back (ADR 0219).
  for (const batch of state.batches.values()) {
    if (!commands.has(batch.id)) issue(fixCommand(state, batch, recipes));
  }
  // A window is every batch's: whichever supervisor ticks first reopens it (ADR 0206), and each
  // reopens at its own reset (ADR 0215).
  const reopen = Object.values(state.usageWindows).some(
    (window) => Date.parse(window.reopensAt) <= now.getTime(),
  );
  return {
    commands: [...commands.values()],
    releaseLeases: expiredLeases.map((lease) => lease.attemptKey).filter((key) => !kept.has(key)),
    ...(reopen ? { reopen: true as const } : {}),
  };
};

/** What a due deadline asks of `batch`: expire, remind (ADR 0025) or `unrouted` (ADR 0032). */
function dueCommand(
  state: State,
  batch: Batch,
  now: Date,
  recipes: Recipes,
): BatchCommand | undefined {
  const { lane } = batch;
  const isDue = (at: string): boolean => Date.parse(at) <= now.getTime();
  switch (lane.kind) {
    case 'brewing': {
      // A paused batch's attempt that has not started waits for continue, not its step (ADR 0202),
      // and any while a usage window is closed for its reopen, whatever its family (ADR 0206,
      // ADR 0215).
      const held =
        pauseOf(state, batch) !== undefined || Object.keys(state.usageWindows).length > 0;
      // An interactive step's open session is a person's wait, with no deadline: its lease ends it
      // when its driver dies (ADR 0222).
      const recipe = batch.recipe && recipes.find(batch.recipe.name);
      const open = (attempt: { phase: string; stepId: string }): boolean =>
        attempt.phase === 'started' &&
        recipe?.has(attempt.stepId) === true &&
        recipe.interactive(attempt.stepId);
      const [late] = running(batch)
        .filter(
          (attempt) =>
            isDue(attempt.deadlineAt) && !(held && attempt.phase === 'scheduled') && !open(attempt),
        )
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

/**
 * The command that sends `batch` back from its open pull request (ADR 0219): on tap, its latest
 * base check of the head of its latest push failed on the merged tree (ADR 0226) or its latest
 * record of the checks on that head failed, its recipe has an onPullRequestFail route, and no pause
 * holds it (ADR 0202). Derived from the folded state alone, so the next tick after a kill issues it
 * again, and decide refuses it once the batch has left on tap.
 */
function fixCommand(state: State, batch: Batch, recipes: Recipes): BatchCommand | undefined {
  if (batch.lane.kind !== 'on_tap' || batch.recipe === undefined) return undefined;
  const recipe = recipes.find(batch.recipe.name);
  if (recipe === undefined || pullRequestRoute(recipe) === undefined) return undefined;
  if (fixHeld(state, batch)) return undefined;
  const problem = pullRequestProblem(state, batch);
  if (problem === undefined) return undefined;
  const { pullRequest, head } = problem;
  return {
    kind: 'fix_pull_request',
    batchId: batch.id,
    pullRequest,
    head,
    cause: causeOf(problem),
  };
}

type Running = AttemptRef & { phase: 'scheduled' | 'started'; deadlineAt: string };

/** The attempts of a brewing batch that run: each the latest of its step, neither finished nor abandoned. */
function running(batch: Batch): Running[] {
  if (batch.lane.kind !== 'brewing') return [];
  const result: Running[] = [];
  for (const [stepId, step] of batch.steps) {
    const latest = runningAttempt(step);
    if (latest !== undefined) {
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
