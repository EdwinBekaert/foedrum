// The batch state machine: the core of the command layer (architecture §4.3, ADR 0019, ADR 0025).
// It takes the folded state and one command, and returns the events to append or a refusal.
// Pure: the caller passes the time, and the recipes through a small interface.

import {
  type Answer,
  type ClaudeReport,
  type Event,
  type GravityReading,
  MAX_OPEN_FINDING_TEXT,
  MOST_OPEN_FINDINGS,
  type OrderRef,
  type Receipt,
  type RoundsOut,
  type ScheduleRoute,
  type StuckOption,
  type StuckReason,
  type Surface,
  type Usage,
  type WaitCondition,
} from '../schemas/events.ts';
import type { HouseYeastSelection } from '../schemas/house-yeast.ts';
import type { BlockerKind, TastingFinding } from '../schemas/out-doc.ts';
import type { StepOutcome } from '../schemas/step-outcome.ts';
import { check, type Decision, laneRefusal, nonTerminal, notAllowed } from './admit.ts';
import { claimedName, claimOfOrder, claimOrderOf } from './claim-orders.ts';
import { effectKey } from './effect-key.ts';
import type { Attempt, Batch, Lane, State } from './fold.ts';
import { claimStanding, same } from './issue-claims.ts';
import { openedPullRequest } from './pull-request.ts';
import type { Recipe, Recipes } from './recipes.ts';

/** Who issued a human command, and from where (ADR 0019). */
interface Issuer {
  batchId: string;
  by: string;
  via: Surface;
}

/** The commands a human issues, mostly to get a Stuck batch moving again. */
export type HumanCommand =
  | ({ kind: 'retry' } & Issuer)
  | ({ kind: 'skip' } & Issuer)
  | ({ kind: 'answer'; answers: readonly Answer[] } & Issuer)
  | ({ kind: 'recipe'; recipe: string; reason: string } & Issuer)
  /** `shas`: the commit of each repository at `toStepId`, by `owner/name`. */
  | ({ kind: 'rewind'; toStepId: string; shas: Readonly<Record<string, string>> } & Issuer)
  | ({ kind: 'cancel' } & Issuer)
  /**
   * A new batch of an issue a person orders by hand (`foedrum order`, ADR 0105): refused while the
   * issue has a live batch, while its last claim is held or being released, or when it is a
   * sub-order (`orderRefusal`).
   */
  | ({ kind: 'order_again'; order: OrderRef } & Issuer)
  /**
   * Hands the batch from the driver `from`, whose live lease runs `until`, to the driver `to`
   * (ADR 0124); the caller reads that lease in the transaction that appends.
   */
  | ({ kind: 'take_over'; from: string; to: string; until: string; resumes?: string } & Issuer);

/**
 * How an attempt ended: a step outcome, or a brewer's `blocked` out doc with its blocker kind, and
 * for a blocking Taster's `changes` its findings (ADR 0192).
 */
export type Ending =
  | StepOutcome
  | {
      kind: 'blocked';
      blockerKind: BlockerKind;
      summary: string;
      findings?: readonly TastingFinding[];
    };

/** Events the engine records as they happen; they decide nothing about a batch's lane. */
export type RecordedEvent = Extract<
  Event,
  {
    type:
      | 'step.started'
      | 'order.decomposed'
      | 'bottle.opened'
      | 'release.observed'
      | 'pull_request.ended'
      | 'effect.applied';
  }
>;

/** The commands the engine issues itself: the drivers and the supervisor. */
export type EngineCommand =
  | { kind: 'record'; event: RecordedEvent }
  /** A new batch of an order or sub-order, Ordered until it is routed by its deadline (ADR 0032). */
  | { kind: 'order'; batchId: string; order: OrderRef; parentBatchId?: string }
  | { kind: 'route'; batchId: string; recipe: string; reason: string; source: 'label' | 'router' }
  | {
      kind: 'finish';
      batchId: string;
      stepId: string;
      attempt: number;
      ending: Ending;
      usage?: Usage;
      /** A check step's gravity readings (ADR 0069), or a brewer's setup's (ADR 0163). */
      readings?: readonly GravityReading[];
      /** What claude reported in its init event, when it came (ADR 0116). */
      claude?: ClaudeReport;
      /** What a brewer's attempt took, once its stream was read (ADR 0172). */
      receipt?: Receipt;
      /** The house-yeast rules the attempt's plan gave it (ADR 0169). */
      houseYeast?: HouseYeastSelection;
    }
  /** The supervisor found the attempt past its deadline (invariant I5). */
  | { kind: 'expire'; batchId: string; stepId: string; attempt: number }
  /** The supervisor found the lease of a running attempt expired: its process is lost (ADR 0027). */
  | { kind: 'lose'; batchId: string; stepId: string; attempt: number; reason: string }
  /** The runner reported no progress for the recipe's stall limit (ADR 0027). */
  | {
      kind: 'stall';
      batchId: string;
      stepId: string;
      attempt: number;
      lastProgressAt: Date;
      turnsWithoutProgress: number;
    }
  | { kind: 'wait'; batchId: string; on: WaitCondition }
  /** The supervisor found an Ordered batch past its routing deadline (ADR 0032). */
  | { kind: 'unrouted'; batchId: string }
  /** The supervisor found a Conditioning or Stuck reminder due. */
  | { kind: 'remind'; batchId: string };

export type Command = HumanCommand | EngineCommand;

export interface Context {
  now: Date;
  recipes: Recipes;
  /** How long a Conditioning or Stuck batch waits before the next reminder, in milliseconds. */
  reminderMs: number;
  /** How long an Ordered batch may wait to be routed, in milliseconds (ADR 0032). */
  routingMs: number;
}

/** The options a Stuck batch offers for `reason`. */
export function stuckOptions(reason: StuckReason): StuckOption[] {
  switch (reason.kind) {
    case 'needs_input':
      return ['answer', ...withoutAnswer];
    case 'blocked':
    case 'attempts_exhausted':
    case 'deadline_passed':
    case 'waiting_for_session':
    case 'stalled':
      return [...withoutAnswer];
    // No step yet to skip, answer or rewind to: route it again, choose a recipe, or cancel it.
    case 'routing':
      return ['retry', 'recipe', 'cancel'];
    default: {
      const unhandled: never = reason;
      throw new Error(`Unhandled stuck reason ${JSON.stringify(unhandled)}`);
    }
  }
}

const withoutAnswer: readonly StuckOption[] = ['retry', 'skip', 'recipe', 'rewind', 'cancel'];

/** The events `command` appends to `state`, or why it is refused. */
export function decide(state: State, command: Command, context: Context): Decision {
  try {
    return { kind: 'accepted', events: run(new Draft(state, context), command) };
  } catch (error) {
    if (error instanceof Refusal) return { kind: 'refused', reason: error.message };
    throw error;
  }
}

/** Why a command is refused; `decide` returns it as a refusal. */
class Refusal extends Error {}

/** The events decided so far, each checked against the state the ones before it lead to. */
class Draft {
  state: State;
  readonly events: Event[] = [];
  readonly context: Context;

  constructor(state: State, context: Context) {
    this.state = state;
    this.context = context;
  }

  push(event: Event): void {
    const checked = check(this.state, event);
    if (checked.kind === 'refused') throw new Refusal(checked.reason);
    this.state = checked.state;
    this.events.push(event);
  }

  batch(batchId: string): Batch {
    const batch = this.state.batches.get(batchId);
    if (batch === undefined) throw new Refusal(`batch ${batchId} was never ordered`);
    return batch;
  }

  /** `ms` from now, as the events write times. */
  after(ms: number): string {
    return new Date(this.context.now.getTime() + ms).toISOString();
  }
}

function run(draft: Draft, command: Command): Event[] {
  switch (command.kind) {
    case 'record':
      draft.push(command.event);
      break;
    case 'order': {
      const { batchId, order, parentBatchId } = command;
      // The intake's claim of a target issue waits on the code host between its read and this
      // order, so `foedrum order` may have ordered the issue in between (ADR 0105).
      if (order.repo !== undefined) refuseOrder(draft.state, batchId, order, busy);
      draft.push({
        type: 'batch.ordered',
        batchId,
        order: { ...order },
        ...(parentBatchId === undefined ? {} : { parentBatchId }),
        routeBy: draft.after(draft.context.routingMs),
        at: draft.after(0),
      });
      break;
    }
    case 'unrouted':
      unrouted(draft, command.batchId);
      break;
    case 'route': {
      requireLane(draft.batch(command.batchId), 'route', ['ordered', 'conditioning']);
      const { batchId, recipe, reason, source } = command;
      draft.push({ type: 'batch.recipe_chosen', batchId, recipe, reason, source });
      enter(draft, batchId, find(draft, recipe).firstStep);
      break;
    }
    case 'recipe': {
      const { batchId, recipe, reason, by, via } = command;
      const batch = draft.batch(batchId);
      requireLane(batch, 'recipe', ['ordered', 'conditioning', 'stuck']);
      requireOffer(batch, 'recipe');
      const { firstStep } = find(draft, recipe);
      draft.push({
        type: 'batch.recipe_chosen',
        batchId,
        recipe,
        reason,
        source: 'human',
        by,
        via,
      });
      if (batch.lane.kind === 'stuck') {
        draft.push({ type: 'batch.resumed', batchId, by, via, action: 'recipe' });
      }
      enter(draft, batchId, firstStep);
      break;
    }
    case 'finish':
      finish(draft, command);
      break;
    case 'expire':
      expire(draft, command);
      break;
    case 'lose':
      lose(draft, command);
      break;
    case 'stall': {
      const { batchId, stepId, attempt, lastProgressAt, turnsWithoutProgress } = command;
      started(requireLane(draft.batch(batchId), 'stall', ['brewing']), stepId, attempt);
      stick(draft, batchId, {
        kind: 'stalled',
        stepId,
        lastProgressAt: lastProgressAt.toISOString(),
        turnsWithoutProgress,
      });
      break;
    }
    case 'wait': {
      const { batchId, on } = command;
      requireLane(draft.batch(batchId), 'wait', ['ordered', 'conditioning']);
      if (on.kind === 'sibling') {
        if (on.batchId === batchId) throw new Refusal(`batch ${batchId} cannot wait for itself`);
        if (!draft.state.batches.has(on.batchId)) {
          throw new Refusal(`sibling batch ${on.batchId} was never ordered`);
        }
      }
      draft.push({
        type: 'batch.waiting',
        batchId,
        on,
        remindAt: draft.after(draft.context.reminderMs),
      });
      break;
    }
    case 'remind':
      remind(draft, command.batchId);
      break;
    case 'retry': {
      const { batchId, by, via } = command;
      const { reason } = stuckLane(draft.batch(batchId), 'retry');
      if (reason.kind === 'routing') {
        // Back to Ordered, for the intake to route again by a new deadline (ADR 0032).
        const routeBy = draft.after(draft.context.routingMs);
        draft.push({ type: 'batch.resumed', batchId, by, via, action: 'retry', routeBy });
        break;
      }
      draft.push({ type: 'batch.resumed', batchId, by, via, action: 'retry' });
      schedule(draft, batchId, reason.stepId, { retry: true });
      resumeGroup(draft, batchId, reason.stepId);
      break;
    }
    case 'skip': {
      const { batchId, by, via } = command;
      const { reason } = stuckLane(draft.batch(batchId), 'skip');
      if (reason.kind === 'routing') throw new Refusal(`batch ${batchId} has no step to skip`);
      draft.push({ type: 'batch.resumed', batchId, by, via, action: 'skip' });
      // A skip of a child skips the rest of its group (ADR 0168).
      const group = recipeOf(draft, draft.batch(batchId)).group(reason.stepId);
      continueAfter(draft, batchId, group ?? reason.stepId);
      break;
    }
    case 'answer':
      answer(draft, command);
      break;
    case 'rewind':
      rewind(draft, command);
      break;
    case 'cancel': {
      const { batchId, by, via } = command;
      requireLane(draft.batch(batchId), 'cancel', nonTerminal);
      draft.push({ type: 'batch.cancelled', batchId, by, via });
      break;
    }
    case 'order_again': {
      const { batchId, order, by, via } = command;
      refuseOrder(draft.state, batchId, order, orderRefusal);
      draft.push({
        type: 'batch.ordered',
        batchId,
        order: { ...order },
        routeBy: draft.after(draft.context.routingMs),
        at: draft.after(0),
        by,
        via,
      });
      break;
    }
    case 'take_over': {
      const { batchId, by, via, from, to, until, resumes } = command;
      requireLane(draft.batch(batchId), 'take over', nonTerminal);
      const event = { type: 'batch.taken_over', batchId, by, via, from, to, until } as const;
      draft.push(resumes === undefined ? event : { ...event, resumes });
      break;
    }
    default: {
      const unhandled: never = command;
      throw new Error(`Unhandled command ${JSON.stringify(unhandled)}`);
    }
  }
  return draft.events;
}

/**
 * Why a person may not order `order` again now (ADR 0105), or undefined: the issue is a sub-order,
 * which its decomposition orders, or `busy` says why.
 */
export function orderRefusal(state: State, order: OrderRef): string | undefined {
  const { issue, repo } = order;
  const subOrder = repo === undefined ? state.subOrders.get(issue) : undefined;
  if (subOrder !== undefined) {
    return `issue #${issue} is a sub-order of #${subOrder.order}; its decomposition orders it`;
  }
  // Its batches are the claimed issue's, which a new claim orders again (ADR 0144).
  const claimed = repo === undefined ? claimOfOrder(state, issue) : undefined;
  if (claimed?.repo !== undefined) {
    return `issue #${issue} is the order of ${claimed.repo}#${claimed.issue}; order ${claimedName(claimed)} again`;
  }
  return busy(state, order);
}

/**
 * Why the issue of `order` may not get a new batch now, or undefined: one of its batches is live,
 * or the claim of a target issue's batch is still held or being released. A new claim made before
 * that release would lose its ref to it.
 */
function busy(state: State, order: OrderRef): string | undefined {
  const { issue, repo } = order;
  for (const batch of state.batches.values()) {
    if (batch.issue !== issue) continue;
    const ofRepo = batch.repo;
    if (ofRepo === undefined ? repo !== undefined : repo === undefined || !same(ofRepo, repo)) {
      continue;
    }
    const of = `batch ${batch.id} of ${ofRepo ?? ''}#${issue}`;
    if (nonTerminal.includes(batch.lane.kind)) return `${of} is still ${batch.lane.kind}`;
    if (ofRepo === undefined) continue;
    const ends = batch.pullRequestEnds ?? {};
    const standing = claimStanding(
      {
        batchId: batch.id,
        repo: ofRepo,
        issue,
        lane: batch.lane,
        order: claimOrderOf(state, batch.id),
      },
      (url) => ends[url] ?? 'open',
      (key) => state.effects.has(effectKey.encode(key)),
    );
    switch (standing) {
      case 'held':
        return `${of} holds its claim until its pull requests end`;
      case 'releasing':
        return `the release of the claim of batch ${batch.id} is still due: foedrum serve applies it, then order ${ofRepo}#${issue} again`;
      case 'released':
        continue;
      default:
        return standing satisfies never;
    }
  }
  return undefined;
}

/** Refuses `order` for `why`, unless `batchId` was ordered before: the fold says so instead. */
function refuseOrder(
  state: State,
  batchId: string,
  order: OrderRef,
  why: (state: State, order: OrderRef) => string | undefined,
): void {
  if (state.batches.has(batchId)) return;
  const refusal = why(state, order);
  if (refusal !== undefined) throw new Refusal(refusal);
}

/** Records how the attempt ended, and moves the batch on as its recipe routes the ending. */
function finish(draft: Draft, command: Extract<Command, { kind: 'finish' }>): void {
  const { batchId, stepId, attempt, ending, usage, readings, claude, receipt, houseYeast } =
    command;
  const recipe = recipeOf(draft, requireLane(draft.batch(batchId), 'finish', ['brewing']));
  // A blocked out doc is a final failure of its attempt; the blocker kind routes it below.
  const outcome: StepOutcome =
    ending.kind === 'blocked'
      ? {
          kind: 'failed',
          retryable: false,
          reason: `${blockedBy(ending.blockerKind)}${ending.summary}`,
        }
      : ending;
  draft.push({
    type: 'step.finished',
    batchId,
    stepId,
    attempt,
    outcome,
    ...(usage === undefined ? {} : { usage }),
    ...(readings === undefined ? {} : { readings: [...readings] }),
    ...(claude === undefined ? {} : { claude }),
    ...(receipt === undefined ? {} : { receipt }),
    ...(houseYeast === undefined ? {} : { houseYeast }),
  });
  if (leftRecipe(draft, recipe, batchId, stepId)) return;
  const batch = draft.batch(batchId);
  switch (ending.kind) {
    case 'succeeded':
      continueAfter(draft, batchId, stepId);
      return;
    case 'failed':
      retryOrStick(draft, batchId, stepId, ending.retryable, ending.reason, true);
      return;
    case 'cancelled':
      retryOrStick(draft, batchId, stepId, true, 'the attempt was cancelled', false);
      return;
    case 'needs_input':
      stick(draft, batchId, { kind: 'needs_input', stepId, questions: ending.questions });
      return;
    case 'blocked': {
      const { blockerKind, summary } = ending;
      const blocked: StuckReason = { kind: 'blocked', stepId, blockerKind, summary };
      switch (blockerKind) {
        case 'findings': {
          // The next round, until the route's rounds are used up (brewers-and-recipes §2).
          const back = recipe.loopBack(batch, stepId, 'findings');
          const group = recipe.group(stepId);
          if (back === undefined) {
            const rounds = recipe.rounds(batch, stepId, 'findings');
            stick(
              draft,
              batchId,
              rounds === undefined
                ? blocked
                : { ...blocked, roundsOut: roundsOut(rounds, ending.findings ?? []) },
            );
          }
          // A child's verdict waits for its group's other children (ADR 0168).
          else if (group !== undefined) settle(draft, batchId, group);
          else goBack(draft, batchId, back, { from: stepId, why: 'findings' });
          return;
        }
        // Another round would hit the same wall, or the plan does not match reality.
        case 'environment':
        case 'divergence':
          stick(draft, batchId, blocked);
          return;
        default: {
          const unhandled: never = blockerKind;
          throw new Error(`Unhandled blocker kind ${JSON.stringify(unhandled)}`);
        }
      }
    }
    default: {
      const unhandled: never = ending;
      throw new Error(`Unhandled ending ${JSON.stringify(unhandled)}`);
    }
  }
}

/**
 * Makes the batch Stuck when `stepId` is no longer in its recipe: the file was changed under the
 * batch (a step renamed or removed), so the recipe cannot say where it goes next.
 */
function leftRecipe(draft: Draft, recipe: Recipe, batchId: string, stepId: string): boolean {
  if (recipe.has(stepId)) return false;
  const name = draft.batch(batchId).recipe?.name;
  const summary = `recipe ${name} has no step ${stepId} any more: its file changed under the batch`;
  stick(draft, batchId, { kind: 'blocked', stepId, blockerKind: 'divergence', summary });
  return true;
}

/**
 * Another attempt at `stepId` while it has some left, then (when `routed`) the `onFail` route back,
 * then Stuck.
 */
function retryOrStick(
  draft: Draft,
  batchId: string,
  stepId: string,
  retryable: boolean,
  lastReason: string,
  routed: boolean,
): void {
  const batch = draft.batch(batchId);
  const recipe = recipeOf(draft, batch);
  if (leftRecipe(draft, recipe, batchId, stepId)) return;
  if (retryable && recipe.mayRetry(batch, stepId)) {
    schedule(draft, batchId, stepId, { retry: true });
    return;
  }
  const back = routed ? recipe.loopBack(batch, stepId, 'failed') : undefined;
  if (back === undefined) {
    const attempts = batch.steps.get(stepId)?.attempts.size ?? 0;
    stick(draft, batchId, { kind: 'attempts_exhausted', stepId, attempts, lastReason });
  } else {
    goBack(draft, batchId, back, { from: stepId, why: 'failed' });
  }
}

/**
 * Schedules `back` along `route`, recorded on the schedule to count its rounds, or makes the
 * batch Stuck on a divergence when the batch skipped `back` (ADR 0064).
 */
function goBack(draft: Draft, batchId: string, back: string, route: ScheduleRoute): void {
  if (draft.batch(batchId).skipped?.has(back)) {
    const summary = `step ${route.from} routes back to step ${back}, which was skipped`;
    stick(draft, batchId, {
      kind: 'blocked',
      stepId: route.from,
      blockerKind: 'divergence',
      summary,
    });
    return;
  }
  schedule(draft, batchId, back, { route });
}

/** An Ordered batch past its routing deadline gets Stuck, so a human hears of it (ADR 0032). */
function unrouted(draft: Draft, batchId: string): void {
  const batch = draft.batch(batchId);
  const { lane } = batch;
  if (lane.kind !== 'ordered') throw new Refusal(notAllowed(batch, 'unrouted', ['ordered']));
  if (draft.context.now.getTime() < Date.parse(lane.routeBy)) {
    throw new Refusal(`batch ${batchId} is not due to be routed until ${lane.routeBy}`);
  }
  stick(draft, batchId, { kind: 'routing', deadlineAt: lane.routeBy });
}

/** A running attempt past its deadline makes the batch Stuck (invariant I5). */
function expire(draft: Draft, command: Extract<Command, { kind: 'expire' }>): void {
  const { batchId, stepId, attempt } = command;
  const batch = requireLane(draft.batch(batchId), 'expire', ['brewing']);
  const current = running(batch, stepId, attempt);
  if (draft.context.now.getTime() < Date.parse(current.deadlineAt)) {
    throw new Refusal(
      `${attemptName(batch, stepId, attempt)} is not due until ${current.deadlineAt}`,
    );
  }
  stick(draft, batchId, { kind: 'deadline_passed', stepId, deadlineAt: current.deadlineAt });
}

/**
 * A started attempt whose lease expired is lost (ADR 0027): it is recorded as a retryable failure,
 * and retried like a cancelled attempt, never along an `onFail` route, which is for failed checks.
 */
function lose(draft: Draft, command: Extract<Command, { kind: 'lose' }>): void {
  const { batchId, stepId, attempt } = command;
  started(requireLane(draft.batch(batchId), 'lose', ['brewing']), stepId, attempt);
  const reason = `the attempt was lost: ${command.reason}`;
  draft.push({
    type: 'step.finished',
    batchId,
    stepId,
    attempt,
    outcome: { kind: 'failed', retryable: true, reason },
  });
  retryOrStick(draft, batchId, stepId, true, reason, false);
}

const attemptName = (batch: Batch, stepId: string, attempt: number): string =>
  `attempt ${stepId}#${attempt} of batch ${batch.id}`;

/** The attempt, when it is the latest of its step and neither finished nor abandoned. */
function running(
  batch: Batch,
  stepId: string,
  attempt: number,
): Exclude<Attempt, { phase: 'finished' }> {
  const attempts = batch.steps.get(stepId)?.attempts;
  const current = attempts?.get(attempt);
  if (
    current === undefined ||
    current.phase === 'finished' ||
    current.abandoned === true ||
    attempt < Math.max(...(attempts?.keys() ?? []))
  ) {
    throw new Refusal(`${attemptName(batch, stepId, attempt)} is not running`);
  }
  return current;
}

/** The running attempt, when its brewer has started. */
function started(batch: Batch, stepId: string, attempt: number): void {
  if (running(batch, stepId, attempt).phase !== 'started') {
    throw new Refusal(`${attemptName(batch, stepId, attempt)} has not started`);
  }
}

/** The next reminder of a Conditioning or Stuck batch, once the current one is due (ADR 0025). */
function remind(draft: Draft, batchId: string): void {
  const batch = draft.batch(batchId);
  const { lane } = batch;
  const due = (remindAt: string): void => {
    if (draft.context.now.getTime() < Date.parse(remindAt)) {
      throw new Refusal(`the reminder of batch ${batchId} is not due until ${remindAt}`);
    }
  };
  const remindAt = draft.after(draft.context.reminderMs);
  switch (lane.kind) {
    case 'conditioning':
      due(lane.remindAt);
      draft.push({ type: 'batch.waiting', batchId, on: lane.on, remindAt });
      return;
    case 'stuck':
      due(lane.remindAt);
      draft.push({
        type: 'batch.stuck',
        batchId,
        reason: lane.reason,
        options: [...lane.options],
        remindAt,
      });
      return;
    case 'ordered':
    case 'brewing':
    case 'on_tap':
    case 'cancelled':
      throw new Refusal(notAllowed(batch, 'remind', ['conditioning', 'stuck']));
    default: {
      const unhandled: never = lane;
      throw new Error(`Unhandled lane ${JSON.stringify(unhandled)}`);
    }
  }
}

/** The answers to the questions that made the batch Stuck resume the step that asked them. */
function answer(draft: Draft, command: Extract<Command, { kind: 'answer' }>): void {
  const { batchId, by, via, answers } = command;
  const { reason } = stuckLane(draft.batch(batchId), 'answer');
  if (reason.kind !== 'needs_input') {
    throw new Refusal(`batch ${batchId} is not waiting for answers`);
  }
  const asked = new Set(reason.questions.map((question) => question.q));
  const answered = new Set<string>();
  for (const { q } of answers) {
    if (!asked.has(q)) throw new Refusal(`no question "${q}" was asked`);
    if (answered.has(q)) throw new Refusal(`question "${q}" has two answers`);
    answered.add(q);
  }
  for (const q of asked) {
    if (!answered.has(q)) throw new Refusal(`question "${q}" has no answer`);
  }
  const { stepId } = reason;
  draft.push({ type: 'input.received', batchId, stepId, by, via, answers: [...answers] });
  draft.push({ type: 'batch.resumed', batchId, by, via, action: 'answer' });
  schedule(draft, batchId, stepId, { answered: true });
  resumeGroup(draft, batchId, stepId);
}

/**
 * Goes back to an earlier step, only from Stuck (ADR 0025): the attempts in flight were abandoned
 * there and the batch's deadlines replaced by its reminder.
 */
function rewind(draft: Draft, command: Extract<Command, { kind: 'rewind' }>): void {
  const { batchId, by, via, toStepId, shas } = command;
  const batch = draft.batch(batchId);
  stuckLane(batch, 'rewind');
  // A step of an earlier recipe: the current one could not tell its deadline or what follows it.
  if (batch.recipe !== undefined && !recipeOf(draft, batch).has(toStepId)) {
    throw new Refusal(`recipe ${batch.recipe.name} has no step ${toStepId}`);
  }
  // No attempt runs a group: the batch rewinds to one of its children (ADR 0168).
  if (batch.recipe !== undefined && recipeOf(draft, batch).children(toStepId) !== undefined) {
    throw new Refusal(
      `step ${toStepId} is a parallel group: rewind to one of its children, which runs the whole group again (ADR 0168)`,
    );
  }
  draft.push({ type: 'batch.rewound', batchId, toStepId, by, via, shas: { ...shas } });
  // A rewind to a child runs its whole group again: the tree its children read changed (ADR 0168).
  const group = recipeOf(draft, batch).group(toStepId);
  const children = group === undefined ? undefined : recipeOf(draft, batch).children(group);
  for (const stepId of children ?? [toStepId]) schedule(draft, batchId, stepId);
}

/**
 * Schedules the next attempt of `stepId`, with the deadline its recipe gives it, the route that
 * sent the batch there, if one did, and whether it runs because the attempt before it failed (a
 * retry, ADR 0117) or a human answered its questions (ADR 0118): then its brewer may resume that
 * attempt's session.
 */
function schedule(
  draft: Draft,
  batchId: string,
  stepId: string,
  { route, retry, answered }: { route?: ScheduleRoute; retry?: true; answered?: true } = {},
): void {
  const batch = draft.batch(batchId);
  requireStep(draft, batch, stepId);
  const attempts = [...(batch.steps.get(stepId)?.attempts.keys() ?? [])];
  draft.push({
    type: 'step.scheduled',
    batchId,
    stepId,
    attempt: Math.max(0, ...attempts) + 1,
    deadlineAt: draft.after(recipeOf(draft, batch).deadlineMs(stepId)),
    ...(route === undefined ? {} : { route }),
    ...(retry === undefined ? {} : { retry }),
    ...(answered === undefined ? {} : { answered }),
  });
}

/**
 * Schedules `stepId` as the batch reaches it, or, when the step's `when` is false, records it as
 * skipped and goes on to what follows (ADR 0064). A human's retry, answer or rewind names its step
 * and schedules it without asking.
 */
function enter(draft: Draft, batchId: string, stepId: string): void {
  const batch = draft.batch(batchId);
  requireStep(draft, batch, stepId);
  const recipe = recipeOf(draft, batch);
  const when = recipe.skip(batch, stepId);
  if (when === undefined) {
    // A parallel group schedules every child at once (ADR 0168).
    for (const child of recipe.children(stepId) ?? [stepId]) schedule(draft, batchId, child);
    return;
  }
  draft.push({ type: 'step.skipped', batchId, stepId, when });
  continueAfter(draft, batchId, stepId);
}

/** Enters the step that follows `stepId` in the batch's recipe, or puts the batch on tap. */
function continueAfter(draft: Draft, batchId: string, stepId: string): void {
  const batch = draft.batch(batchId);
  requireStep(draft, batch, stepId);
  const recipe = recipeOf(draft, batch);
  // A child that succeeded waits for its group's other children (ADR 0168).
  const group = recipe.group(stepId);
  if (group !== undefined) {
    settle(draft, batchId, group);
    return;
  }
  const next = recipe.after(batch, stepId);
  switch (next.kind) {
    case 'step':
      enter(draft, batchId, next.stepId);
      return;
    case 'done': {
      const pullRequests = [...next.pullRequests];
      // A recipe with the openPullRequest action goes on tap only with its pull request, unless
      // its when skipped it (ADR 0071).
      const { opens } = next;
      if (opens !== undefined && batch.skipped?.has(opens) !== true) {
        const opened = openedPullRequest(draft.state, batchId);
        if (opened === undefined) {
          throw new Refusal(
            `batch ${batchId} goes on tap only with the pull request of its step ${opens}, and the ledger has none`,
          );
        }
        pullRequests.push(opened);
      }
      draft.push({ type: 'batch.on_tap', batchId, pullRequests });
      return;
    }
    default: {
      const unhandled: never = next;
      throw new Error(`Unhandled continuation ${JSON.stringify(unhandled)}`);
    }
  }
}

/**
 * What a findings route that used its `rounds` leaves open (ADR 0192): the first findings of its
 * last round, cut to what the status comment reads of them, and a count of the rest. Every finding
 * is open until the step the route goes back to can settle one by a disposition (ADR 0191, #501).
 */
const roundsOut = (rounds: number, findings: readonly TastingFinding[]): RoundsOut => {
  const cut = (text: string) => text.slice(0, MAX_OPEN_FINDING_TEXT);
  const open = findings.slice(0, MOST_OPEN_FINDINGS).map(({ file, why, ...finding }) => ({
    ...finding,
    ...(file === undefined ? {} : { file: cut(file) }),
    why: cut(why),
  }));
  return { rounds, open, more: findings.length - open.length };
};

/** How a blocked out doc's failure reason starts, by its blocker kind. */
const blockedBy = (kind: BlockerKind): string => `blocked (${kind}): `;

/** Whether `outcome` is a blocked out doc's on findings: a blocking Taster's `changes` (ADR 0161). */
const onFindings = (outcome: StepOutcome): boolean =>
  outcome.kind === 'failed' &&
  !outcome.retryable &&
  outcome.reason.startsWith(blockedBy('findings'));

/** The latest attempt of `stepId` in `batch`, if it has one. */
const latestOf = (batch: Batch, stepId: string): Attempt | undefined => {
  const attempts = batch.steps.get(stepId)?.attempts;
  return attempts === undefined ? undefined : attempts.get(Math.max(...attempts.keys()));
};

/**
 * The step the child `stepId` of a parallel group goes back to once its group ended: its latest
 * attempt was blocked by findings with its route's rounds not used up (ADR 0168).
 */
function sentBack(batch: Batch, recipe: Recipe, stepId: string): string | undefined {
  const latest = latestOf(batch, stepId);
  if (latest?.phase !== 'finished' || !onFindings(latest.outcome)) return undefined;
  return recipe.loopBack(batch, stepId, 'findings');
}

/**
 * Whether the child `stepId` of a parallel group has ended (ADR 0168): its latest attempt
 * succeeded, or it was blocked by findings with its route's rounds not used up. Every other ending
 * retries the child or makes the batch Stuck.
 */
function ended(batch: Batch, recipe: Recipe, stepId: string): boolean {
  const latest = latestOf(batch, stepId);
  if (latest?.phase === 'finished' && latest.outcome.kind === 'succeeded') return true;
  return sentBack(batch, recipe, stepId) !== undefined;
}

/**
 * Ends the parallel group `group` once every child of it has ended (ADR 0168): back along the
 * route of its first child that was blocked by findings, else on to the step after the group.
 */
function settle(draft: Draft, batchId: string, group: string): void {
  const batch = draft.batch(batchId);
  const recipe = recipeOf(draft, batch);
  const children = recipe.children(group) ?? [];
  // Never past the group while an attempt of the batch runs: a sibling, or a child its recipe
  // dropped, whose finish then makes the batch Stuck (`leftRecipe`).
  const inFlight = [...batch.steps.keys()].some((stepId) => {
    const latest = latestOf(batch, stepId);
    return latest !== undefined && latest.phase !== 'finished' && latest.abandoned !== true;
  });
  if (inFlight) return;
  // A child the batch never scheduled joined the group after the batch entered it: its file
  // changed under the batch, and the group would wait for it with nothing in flight.
  const added = children.find((child) => !batch.steps.has(child));
  if (added !== undefined) {
    const summary = `the parallel group ${group} of recipe ${batch.recipe?.name} has a child ${added} the batch never scheduled: its file changed under the batch`;
    stick(draft, batchId, { kind: 'blocked', stepId: added, blockerKind: 'divergence', summary });
    return;
  }
  if (!children.every((child) => ended(batch, recipe, child))) return;
  for (const child of children) {
    const back = sentBack(batch, recipe, child);
    if (back !== undefined) {
      goBack(draft, batchId, back, { from: child, why: 'findings' });
      return;
    }
  }
  continueAfter(draft, batchId, group);
}

/**
 * Schedules again every other child of the group `stepId` is a child of that has not ended, so a
 * retry or an answer resumes the group where it stood (ADR 0168).
 */
function resumeGroup(draft: Draft, batchId: string, stepId: string): void {
  const batch = draft.batch(batchId);
  const recipe = recipeOf(draft, batch);
  const group = recipe.group(stepId);
  if (group === undefined) return;
  for (const child of recipe.children(group) ?? []) {
    if (child !== stepId && !ended(batch, recipe, child)) schedule(draft, batchId, child);
  }
}

/** Makes the batch Stuck with the options its reason offers and a reminder (ADR 0025). */
function stick(draft: Draft, batchId: string, reason: StuckReason): void {
  draft.push({
    type: 'batch.stuck',
    batchId,
    reason,
    options: stuckOptions(reason),
    remindAt: draft.after(draft.context.reminderMs),
  });
}

function requireLane(batch: Batch, what: string, allowed: readonly Lane['kind'][]): Batch {
  const refusal = laneRefusal(batch, what, allowed);
  if (refusal !== undefined) throw new Refusal(refusal);
  return batch;
}

function requireOffer(batch: Batch, option: StuckOption): void {
  if (batch.lane.kind === 'stuck' && !batch.lane.options.includes(option)) {
    throw new Refusal(`batch ${batch.id} does not offer ${option}`);
  }
}

/** The Stuck lane of `batch`, when it is Stuck and offers `option`. */
function stuckLane(batch: Batch, option: StuckOption): Extract<Lane, { kind: 'stuck' }> {
  const { lane } = batch;
  if (lane.kind !== 'stuck') throw new Refusal(notAllowed(batch, option, ['stuck']));
  requireOffer(batch, option);
  return lane;
}

function find(draft: Draft, name: string): Recipe {
  const recipe = draft.context.recipes.find(name);
  if (recipe === undefined) throw new Refusal(`the Brewery has no recipe ${name}`);
  return recipe;
}

/** Refuses a step the batch's recipe does not have: its file changed under the batch. */
function requireStep(draft: Draft, batch: Batch, stepId: string): void {
  if (!recipeOf(draft, batch).has(stepId)) {
    throw new Refusal(`recipe ${batch.recipe?.name} has no step ${stepId}`);
  }
}

function recipeOf(draft: Draft, batch: Batch): Recipe {
  if (batch.recipe === undefined) throw new Refusal(`batch ${batch.id} has no recipe`);
  return find(draft, batch.recipe.name);
}
