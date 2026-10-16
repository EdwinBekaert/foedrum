// The batch state machine: the core of the command layer (architecture §4.3, ADR 0019, ADR 0025).
// It takes the folded state and one command, and returns the events to append or a refusal.
// Pure: the caller passes the time, and the recipes through a small interface.

import type {
  Answer,
  Event,
  OrderRef,
  StuckOption,
  StuckReason,
  Surface,
  Usage,
  WaitCondition,
} from '../schemas/events.ts';
import type { BlockerKind } from '../schemas/out-doc.ts';
import type { StepOutcome } from '../schemas/step-outcome.ts';
import { check, type Decision, laneRefusal, nonTerminal, notAllowed } from './admit.ts';
import type { Attempt, Batch, Lane, State } from './fold.ts';
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
  | ({ kind: 'cancel' } & Issuer);

/** How an attempt ended: a step outcome, or a brewer's `blocked` out doc with its blocker kind. */
export type Ending = StepOutcome | { kind: 'blocked'; blockerKind: BlockerKind; summary: string };

/** Events the engine records as they happen; they decide nothing about a batch's lane. */
export type RecordedEvent = Extract<
  Event,
  {
    type:
      | 'batch.ordered'
      | 'step.started'
      | 'order.decomposed'
      | 'bottle.opened'
      | 'release.observed'
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
    case 'routing':
      throw new Error('not implemented');
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
    case 'order':
    case 'unrouted':
      throw new Error('not implemented');
    case 'route': {
      requireLane(draft.batch(command.batchId), 'route', ['ordered', 'conditioning']);
      const { batchId, recipe, reason, source } = command;
      draft.push({ type: 'batch.recipe_chosen', batchId, recipe, reason, source });
      schedule(draft, batchId, find(draft, recipe).firstStep);
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
      schedule(draft, batchId, firstStep);
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
      if (reason.kind === 'routing') throw new Error('not implemented');
      draft.push({ type: 'batch.resumed', batchId, by, via, action: 'retry' });
      schedule(draft, batchId, reason.stepId);
      break;
    }
    case 'skip': {
      const { batchId, by, via } = command;
      const { reason } = stuckLane(draft.batch(batchId), 'skip');
      if (reason.kind === 'routing') throw new Error('not implemented');
      draft.push({ type: 'batch.resumed', batchId, by, via, action: 'skip' });
      continueAfter(draft, batchId, reason.stepId);
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
    default: {
      const unhandled: never = command;
      throw new Error(`Unhandled command ${JSON.stringify(unhandled)}`);
    }
  }
  return draft.events;
}

/** Records how the attempt ended, and moves the batch on as its recipe routes the ending. */
function finish(draft: Draft, command: Extract<Command, { kind: 'finish' }>): void {
  const { batchId, stepId, attempt, ending, usage } = command;
  const recipe = recipeOf(draft, requireLane(draft.batch(batchId), 'finish', ['brewing']));
  // A blocked out doc is a final failure of its attempt; the blocker kind routes it below.
  const outcome: StepOutcome =
    ending.kind === 'blocked'
      ? {
          kind: 'failed',
          retryable: false,
          reason: `blocked (${ending.blockerKind}): ${ending.summary}`,
        }
      : ending;
  draft.push({
    type: 'step.finished',
    batchId,
    stepId,
    attempt,
    outcome,
    ...(usage === undefined ? {} : { usage }),
  });
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
          if (back === undefined) stick(draft, batchId, blocked);
          else schedule(draft, batchId, back);
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
  if (retryable && recipe.mayRetry(batch, stepId)) {
    schedule(draft, batchId, stepId);
    return;
  }
  const back = routed ? recipe.loopBack(batch, stepId, 'failed') : undefined;
  if (back === undefined) {
    const attempts = batch.steps.get(stepId)?.attempts.size ?? 0;
    stick(draft, batchId, { kind: 'attempts_exhausted', stepId, attempts, lastReason });
  } else {
    schedule(draft, batchId, back);
  }
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
  schedule(draft, batchId, stepId);
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
  draft.push({ type: 'batch.rewound', batchId, toStepId, by, via, shas: { ...shas } });
  schedule(draft, batchId, toStepId);
}

/** Schedules the next attempt of `stepId`, with the deadline its recipe gives it. */
function schedule(draft: Draft, batchId: string, stepId: string): void {
  const batch = draft.batch(batchId);
  const attempts = [...(batch.steps.get(stepId)?.attempts.keys() ?? [])];
  draft.push({
    type: 'step.scheduled',
    batchId,
    stepId,
    attempt: Math.max(0, ...attempts) + 1,
    deadlineAt: draft.after(recipeOf(draft, batch).deadlineMs(stepId)),
  });
}

/** Schedules what follows `stepId` in the batch's recipe, or puts the batch on tap. */
function continueAfter(draft: Draft, batchId: string, stepId: string): void {
  const batch = draft.batch(batchId);
  const next = recipeOf(draft, batch).after(batch, stepId);
  switch (next.kind) {
    case 'step':
      schedule(draft, batchId, next.stepId);
      return;
    case 'done':
      draft.push({ type: 'batch.on_tap', batchId, pullRequests: [...next.pullRequests] });
      return;
    default: {
      const unhandled: never = next;
      throw new Error(`Unhandled continuation ${JSON.stringify(unhandled)}`);
    }
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

function recipeOf(draft: Draft, batch: Batch): Recipe {
  if (batch.recipe === undefined) throw new Refusal(`batch ${batch.id} has no recipe`);
  return find(draft, batch.recipe.name);
}
