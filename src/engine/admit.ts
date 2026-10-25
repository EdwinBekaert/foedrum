// The guard before append: refuses events the fold would throw on, and the lifecycle and bottling
// rules the fold leaves out (architecture §4.1, §4.3, ADR 0013, ADR 0025). Pure: no clock or I/O.

import { Event } from '../schemas/events.ts';
import { z } from '../schemas/zod.ts';
import { type Batch, fold, InvalidLogError, type Lane, type State } from './fold.ts';

/** What the command layer appends, or why it appends nothing. */
export type Decision =
  | { kind: 'accepted'; events: readonly Event[] }
  | { kind: 'refused'; reason: string };

/**
 * Accepts `events` when each one, folded onto `state` and the events before it, is valid and
 * allowed in its batch's lane; otherwise refuses all of them, naming the first refused event.
 */
export function admit(state: State, events: readonly Event[]): Decision {
  let current = state;
  for (const [index, event] of events.entries()) {
    const checked = check(current, event);
    if (checked.kind === 'refused') {
      return { kind: 'refused', reason: `event ${index} (${event.type}): ${checked.reason}` };
    }
    current = checked.state;
  }
  return { kind: 'accepted', events };
}

/** Checks one event against `state`: the state it leads to, or why it is refused. */
export function check(
  state: State,
  event: Event,
): { kind: 'admitted'; state: State } | { kind: 'refused'; reason: string } {
  const parsed = Event.safeParse(event);
  if (!parsed.success) return { kind: 'refused', reason: z.prettifyError(parsed.error) };
  // The lifecycle rules first: "batch b1 is ordered" says more than "step plan was never scheduled".
  const reason = rule(state, event);
  if (reason !== undefined) return { kind: 'refused', reason };
  try {
    return { kind: 'admitted', state: fold([event], state) };
  } catch (error) {
    if (error instanceof InvalidLogError) return { kind: 'refused', reason: error.reason };
    throw error;
  }
}

/** Why `what` is refused in `batch`'s lane, or `undefined` when that lane is one of `allowed`. */
export function laneRefusal(
  batch: Batch,
  what: string,
  allowed: readonly Lane['kind'][],
): string | undefined {
  return allowed.includes(batch.lane.kind) ? undefined : notAllowed(batch, what, allowed);
}

/** Says that `what` needs `batch` in one of the `allowed` lanes. */
export function notAllowed(batch: Batch, what: string, allowed: readonly Lane['kind'][]): string {
  const list =
    allowed.length === 1
      ? allowed.join('')
      : `${allowed.slice(0, -1).join(', ')} or ${allowed.at(-1)}`;
  return `batch ${batch.id} is ${batch.lane.kind}; ${what} needs it ${list}`;
}

export const nonTerminal: readonly Lane['kind'][] = ['ordered', 'brewing', 'conditioning', 'stuck'];

/** Why `event` is not allowed in `state`, beyond what the fold checks; `undefined` when it is. */
function rule(state: State, event: Event): string | undefined {
  switch (event.type) {
    case 'batch.ordered':
    case 'release.observed':
    case 'effect.applied':
      return undefined;
    case 'batch.recipe_chosen':
      return lanes(state, event, ['ordered', 'conditioning', 'stuck']);
    case 'step.scheduled':
    case 'step.skipped':
      return lanes(state, event, ['ordered', 'brewing', 'conditioning']);
    case 'step.started':
    case 'step.finished':
      return lanes(state, event, ['brewing']) ?? latestAttempt(state, event);
    case 'input.received': {
      const refusal = lanes(state, event, ['stuck']);
      if (refusal !== undefined) return refusal;
      const { lane } = state.batches.get(event.batchId) ?? {};
      return lane?.kind === 'stuck' &&
        lane.reason.kind === 'needs_input' &&
        lane.reason.stepId === event.stepId
        ? undefined
        : `batch ${event.batchId} is not waiting for answers to step ${event.stepId}`;
    }
    case 'batch.stuck': {
      // Stuck on routing only before a recipe, and on a step only after one (ADR 0032).
      const routing = event.reason.kind === 'routing';
      const allowed: Lane['kind'][] = routing ? ['ordered', 'stuck'] : ['brewing', 'stuck'];
      return lanes(state, event, allowed) ?? stuckOn(state, event.batchId, routing);
    }
    case 'batch.resumed':
      return (
        lanes(state, event, ['stuck']) ??
        offered(state, event.batchId, event.action) ??
        reordered(state, event)
      );
    case 'batch.rewound':
      return (
        lanes(state, event, ['stuck']) ??
        offered(state, event.batchId, 'rewind') ??
        rewindable(state, event)
      );
    case 'order.decomposed':
      return lanes(state, event, nonTerminal) ?? keepsRepositories(state, event);
    case 'batch.waiting':
      return lanes(state, event, ['ordered', 'conditioning']);
    case 'bottle.opened':
      return bottleable(state, event);
    case 'batch.on_tap':
      return lanes(state, event, ['brewing']);
    case 'batch.taken_over':
    case 'batch.cancelled':
      return lanes(state, event, nonTerminal);
    case 'pull_request.ended':
      return endable(state, event);
    case 'pull_request.base_checked':
      return checkable(state, event);
    default: {
      const unhandled: never = event;
      throw new Error(`Unhandled event ${JSON.stringify(unhandled)}`);
    }
  }
}

/** A lane refusal for an event of a batch; a batch the log never ordered is the fold's to refuse. */
function lanes(
  state: State,
  event: Event & { batchId: string },
  allowed: readonly Lane['kind'][],
): string | undefined {
  const batch = state.batches.get(event.batchId);
  return batch && laneRefusal(batch, event.type, allowed);
}

function offered(state: State, batchId: string, option: string): string | undefined {
  const lane = state.batches.get(batchId)?.lane;
  return lane?.kind === 'stuck' && !lane.options.some((offer) => offer === option)
    ? `batch ${batchId} does not offer ${option}`
    : undefined;
}

/** Whether a Stuck batch is stuck on routing as `routing` says; other lanes pass. */
function stuckOn(state: State, batchId: string, routing: boolean): string | undefined {
  const lane = state.batches.get(batchId)?.lane;
  if (lane?.kind !== 'stuck' || (lane.reason.kind === 'routing') === routing) return undefined;
  return routing
    ? `batch ${batchId} is stuck at a step (${lane.reason.kind}), not on routing`
    : `batch ${batchId} is stuck on routing, not at a step`;
}

/**
 * A retry of a batch Stuck on routing sends it back to Ordered, so it needs a new routing deadline;
 * every other resume goes on brewing and has none (ADR 0032).
 */
function reordered(
  state: State,
  event: Extract<Event, { type: 'batch.resumed' }>,
): string | undefined {
  const lane = state.batches.get(event.batchId)?.lane;
  const needs =
    lane?.kind === 'stuck' && lane.reason.kind === 'routing' && event.action === 'retry';
  if (needs === (event.routeBy !== undefined)) return undefined;
  return needs
    ? `batch ${event.batchId} goes back to ordered; its retry needs a routing deadline`
    : `batch ${event.batchId} goes on brewing; its ${event.action} takes no routing deadline`;
}

/** Only an attempt that no later attempt replaced, and that Stuck did not abandon, may start or finish. */
function latestAttempt(
  state: State,
  { batchId, stepId, attempt }: Extract<Event, { type: 'step.started' | 'step.finished' }>,
): string | undefined {
  const attempts = state.batches.get(batchId)?.steps.get(stepId)?.attempts;
  const current = attempts?.get(attempt);
  if (attempts === undefined || current === undefined) return undefined;
  const name = `attempt ${stepId}#${attempt} of batch ${batchId}`;
  if (attempt < Math.max(...attempts.keys()))
    return `${name} is not the latest attempt of its step`;
  return current.phase !== 'finished' && current.abandoned
    ? `${name} was abandoned when the batch got stuck`
    : undefined;
}

/**
 * A rewind names the commit of each repository it resets; the batch of a sub-order or of a
 * claimed target issue only its own.
 */
function rewindable(
  state: State,
  event: Extract<Event, { type: 'batch.rewound' }>,
): string | undefined {
  const repos = Object.keys(event.shas);
  if (repos.length === 0) return 'rewind needs the commit of each repository';
  const only = (repo: string): boolean => repos.length === 1 && repos[0] === repo;
  const batch = state.batches.get(event.batchId);
  if (batch?.repo !== undefined) {
    return only(batch.repo) ? undefined : `issue ${batch.issue} of ${batch.repo} writes only there`;
  }
  const subOrder = batch === undefined ? undefined : state.subOrders.get(batch.issue);
  return subOrder !== undefined && !only(subOrder.repo)
    ? `sub-order ${subOrder.issue} writes only in ${subOrder.repo}`
    : undefined;
}

/** A batch records the end of a pull request it opened (on tap) or waits for (Conditioning). */
function endable(
  state: State,
  event: Extract<Event, { type: 'pull_request.ended' }>,
): string | undefined {
  const lane = state.batches.get(event.batchId)?.lane;
  if (lane === undefined) return undefined;
  const ours =
    (lane.kind === 'on_tap' && lane.pullRequests.includes(event.pullRequest)) ||
    (lane.kind === 'conditioning' &&
      lane.on.kind === 'merge' &&
      lane.on.pullRequest === event.pullRequest);
  return ours
    ? undefined
    : `batch ${event.batchId} neither opened nor waits for ${event.pullRequest}`;
}

/** A batch records how an open pull request it opened merges with its base (ADR 0198). */
function checkable(
  _state: State,
  _event: Extract<Event, { type: 'pull_request.base_checked' }>,
): string | undefined {
  throw new Error('not implemented');
}

/** A sub-order keeps its repository once it has batches: they, and their branches, live there. */
function keepsRepositories(
  state: State,
  event: Extract<Event, { type: 'order.decomposed' }>,
): string | undefined {
  for (const { issue, repo } of event.subOrders) {
    const earlier = state.subOrders.get(issue);
    if (earlier !== undefined && earlier.repo !== repo && earlier.batchIds.length > 0) {
      return `sub-order ${issue} has batches in ${earlier.repo}, so it cannot move to ${repo}`;
    }
  }
  return undefined;
}

/** A bottle bundles finished sub-orders of its own repository (ADR 0013). */
function bottleable(
  state: State,
  event: Extract<Event, { type: 'bottle.opened' }>,
): string | undefined {
  for (const issue of event.subOrders) {
    const subOrder = state.subOrders.get(issue);
    if (subOrder === undefined) return `sub-order ${issue} does not exist`;
    if (subOrder.repo !== event.repo) {
      return `sub-order ${issue} targets ${subOrder.repo}, not ${event.repo}`;
    }
    const onTap = subOrder.batchIds.some(
      (batchId) => state.batches.get(batchId)?.lane.kind === 'on_tap',
    );
    if (!onTap) return `sub-order ${issue} has no batch on tap`;
  }
  return undefined;
}
