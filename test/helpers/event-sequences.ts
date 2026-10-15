// A seeded generator of valid event sequences for property tests (architecture §9).
// The same seed always gives the same events, so a failing seed can be replayed.

import { nonTerminal } from '../../src/engine/admit.ts';
import { type AttemptRef, attemptKey } from '../../src/engine/attempt-key.ts';
import { nextBatchId } from '../../src/engine/batch-id.ts';
import type { Command, RecordedEvent } from '../../src/engine/decide.ts';
import { effectKey } from '../../src/engine/effect-key.ts';
import type { Batch, Lane, State } from '../../src/engine/fold.ts';
import type { Event, StuckOption, StuckReason, WaitCondition } from '../../src/schemas/events.ts';
import type { BlockerKind } from '../../src/schemas/out-doc.ts';
import type { StepOutcome } from '../../src/schemas/step-outcome.ts';
import type { FakeRecipe } from './fake-recipes.ts';

export interface Random {
  /** An integer in [0, max). */
  int: (max: number) => number;
  pick: <T>(items: readonly T[]) => T;
  chance: (p: number) => boolean;
}

/** mulberry32: small, fast and good enough to explore event orders. */
export const seededRandom = (seed: number): Random => {
  let a = seed >>> 0;
  const next = (): number => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (max: number): number => Math.floor(next() * max);
  return {
    int,
    pick: (items) => {
      if (items.length === 0) throw new Error('Cannot pick from an empty list');
      return items[int(items.length)] as (typeof items)[number];
    },
    chance: (p) => next() < p,
  };
};

interface SimStep {
  attempt: number;
  phase: 'scheduled' | 'started' | 'finished';
}

interface SimBatch {
  id: string;
  issue: number;
  subOrder: boolean;
  open: boolean;
  steps: Map<string, SimStep>;
}

const repos = ['acme/lib-core', 'acme/api', 'acme/web'];
const stepIds = ['plan', 'tests', 'implement', 'review'];
const allOptions: readonly StuckOption[] = [
  'answer',
  'retry',
  'skip',
  'recipe',
  'rewind',
  'cancel',
];
const surfaces = ['plugin', 'terminal', 'comment', 'dashboard'] as const;
const effects = ['pull_request', 'comment', 'label'];
const question = {
  q: 'Keep the v1 endpoint?',
  options: ['keep', 'remove'],
  recommended: 'keep',
  whyBlocking: 'Removing it breaks the mobile app',
};
const base = Date.UTC(2026, 9, 15);

/**
 * `length` events in an order an engine could have written them: batches are ordered before
 * anything refers to them, attempts are scheduled, started and finished in turn, and nothing
 * happens to a batch after it is on tap or cancelled. Lane transitions are not enforced (#14).
 */
export const generateEvents = (seed: number, length = 60): Event[] => {
  const random = seededRandom(seed);
  const batches: SimBatch[] = [];
  const subOrders: { issue: number; parentBatchId: string }[] = [];
  /** The latest breakdown of each order, by its issue. */
  const breakdowns = new Map<number, { issue: number; repo: string }[]>();
  const applied = new Set<string>();
  let nextIssue = 100;
  let nextId = 1;
  let tick = 0;

  const timestamp = (): string => new Date(base + tick++ * 60_000).toISOString();
  const sha = (): string => (random.int(0xfffffff) + 1).toString(16).padStart(40, '0');
  const pullRequest = (repo: string): string =>
    `https://github.com/${repo}/pull/${random.int(500) + 1}`;
  const open = (): SimBatch | undefined => {
    const candidates = batches.filter((batch) => batch.open);
    return candidates.length === 0 ? undefined : random.pick(candidates);
  };
  const withStep = (): [SimBatch, string, SimStep] | undefined => {
    const batch = open();
    if (batch === undefined || batch.steps.size === 0) return undefined;
    const [stepId, step] = random.pick([...batch.steps]);
    return [batch, stepId, step];
  };
  const order = (issue: number, parentBatchId?: string): Event => {
    const batch = {
      id: `b${nextId++}`,
      issue,
      subOrder: parentBatchId !== undefined,
      open: true,
      steps: new Map(),
    };
    batches.push(batch);
    return {
      type: 'batch.ordered',
      batchId: batch.id,
      order: { issue },
      ...(parentBatchId === undefined ? {} : { parentBatchId }),
    };
  };
  const stuckReason = (stepId: string): StuckReason => {
    switch (random.int(6)) {
      case 0:
        return { kind: 'needs_input', stepId, questions: [question] };
      case 1:
        return { kind: 'blocked', stepId, blockerKind: 'environment', summary: 'CI is down' };
      case 2:
        return { kind: 'attempts_exhausted', stepId, attempts: 3, lastReason: 'tests fail' };
      case 3:
        return { kind: 'deadline_passed', stepId, deadlineAt: timestamp() };
      case 4:
        return { kind: 'stalled', stepId, lastProgressAt: timestamp(), turnsWithoutProgress: 60 };
      default:
        return { kind: 'waiting_for_session', stepId };
    }
  };
  const outcome = (): StepOutcome => {
    switch (random.int(4)) {
      case 0:
        return { kind: 'succeeded', output: { notes: random.int(10) } };
      case 1:
        return { kind: 'failed', retryable: random.chance(0.5), reason: 'tests fail' };
      case 2:
        return { kind: 'needs_input', questions: [question] };
      default:
        return { kind: 'cancelled' };
    }
  };
  const waitCondition = (): WaitCondition => {
    switch (random.int(3)) {
      case 0:
        return { kind: 'merge', pullRequest: pullRequest(random.pick(repos)) };
      case 1:
        return { kind: 'release', repo: 'acme/lib-core', package: 'lib-core', minVersion: '2.4.0' };
      default:
        return { kind: 'sibling', batchId: random.pick(batches).id };
    }
  };

  const actions: (() => Event | undefined)[] = [
    () => {
      const pending = subOrders.findIndex(() => random.chance(0.5));
      if (pending === -1) return order(nextIssue++);
      const [subOrder] = subOrders.splice(pending, 1);
      return subOrder && order(subOrder.issue, subOrder.parentBatchId);
    },
    () => {
      const batch = open();
      if (batch === undefined) return undefined;
      const chosen = {
        type: 'batch.recipe_chosen',
        batchId: batch.id,
        recipe: random.pick(['nip', 'pint', 'growler']),
        reason: 'label',
      } as const;
      return random.chance(1 / 3)
        ? { ...chosen, source: 'human', by: 'octocat', via: random.pick(surfaces) }
        : { ...chosen, source: random.pick(['label', 'router'] as const) };
    },
    () => {
      const batch = open();
      if (batch === undefined) return undefined;
      const stepId = random.pick(stepIds);
      const step = batch.steps.get(stepId);
      if (step !== undefined && step.phase !== 'finished') return undefined;
      const attempt = (step?.attempt ?? 0) + 1;
      batch.steps.set(stepId, { attempt, phase: 'scheduled' });
      return {
        type: 'step.scheduled',
        batchId: batch.id,
        stepId,
        attempt,
        deadlineAt: timestamp(),
      };
    },
    () => {
      const found = withStep();
      if (found === undefined || found[2].phase !== 'scheduled') return undefined;
      const [batch, stepId, step] = found;
      step.phase = 'started';
      const session = {
        id: `s${nextId++}`,
        ...(random.chance(0.3) ? { resumes: 's0' } : {}),
        worktree: `work/${batch.id}/${stepId}`,
        claudeVersion: '2.1.300',
      };
      return {
        type: 'step.started',
        batchId: batch.id,
        stepId,
        attempt: step.attempt,
        ...(random.chance(0.7) ? { session } : {}),
      };
    },
    () => {
      const found = withStep();
      if (found === undefined || found[2].phase !== 'started') return undefined;
      const [batch, stepId, step] = found;
      step.phase = 'finished';
      const usage = { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 1 };
      return {
        type: 'step.finished',
        batchId: batch.id,
        stepId,
        attempt: step.attempt,
        outcome: outcome(),
        ...(random.chance(0.5) ? { usage } : {}),
      };
    },
    () => {
      const found = withStep();
      if (found === undefined) return undefined;
      return {
        type: 'input.received',
        batchId: found[0].id,
        stepId: found[1],
        by: 'octocat',
        via: random.pick(surfaces),
        answers: [{ q: question.q, answer: 'keep' }],
      };
    },
    () => {
      const found = withStep();
      if (found === undefined) return undefined;
      const options = allOptions.filter(() => random.chance(0.5));
      return {
        type: 'batch.stuck',
        batchId: found[0].id,
        reason: stuckReason(found[1]),
        options: options.length === 0 ? ['cancel'] : options,
        remindAt: timestamp(),
      };
    },
    () => {
      const batch = open();
      if (batch === undefined) return undefined;
      return {
        type: 'batch.resumed',
        batchId: batch.id,
        by: 'octocat',
        via: random.pick(surfaces),
        action: random.pick(['retry', 'skip', 'recipe', 'answer'] as const),
      };
    },
    () => {
      // One level of breakdown (ADR 0013): only a batch of an order is decomposed.
      const candidates = batches.filter((batch) => batch.open && !batch.subOrder);
      if (candidates.length === 0) return undefined;
      const batch = random.pick(candidates);
      // Sometimes every new sub-order targets one repository, with or without dependencies.
      const sameRepo = random.chance(0.3) ? random.pick(repos) : undefined;
      const fresh = Array.from({ length: random.int(3) + 1 }, () => ({
        issue: nextIssue++,
        repo: sameRepo ?? random.pick(repos),
      }));
      for (const { issue } of fresh) subOrders.push({ issue, parentBatchId: batch.id });
      // A new breakdown keeps some sub-orders of the last one; the others are cancelled.
      const kept = (breakdowns.get(batch.issue) ?? []).filter(() => random.chance(0.5));
      const breakdown = [...kept, ...fresh];
      breakdowns.set(batch.issue, breakdown);
      const issues = breakdown.map((subOrder) => subOrder.issue);
      return {
        type: 'order.decomposed',
        batchId: batch.id,
        subOrders: breakdown,
        // Only on earlier sub-orders, so the breakdown never has a cycle.
        dependencies: issues.flatMap((subOrder, i) =>
          issues
            .slice(0, i)
            .filter(() => random.chance(0.4))
            .map((blockedBy) => ({
              subOrder,
              blockedBy,
              kind: random.pick(['code', 'release'] as const),
            })),
        ),
      };
    },
    () => {
      const batch = open();
      if (batch === undefined) return undefined;
      return {
        type: 'batch.waiting',
        batchId: batch.id,
        on: waitCondition(),
        remindAt: timestamp(),
      };
    },
    () => {
      const repo = random.pick(repos);
      return {
        type: 'bottle.opened',
        bottleId: `bottle${nextId++}`,
        repo,
        subOrders: [100 + random.int(nextIssue - 100)],
        pullRequest: pullRequest(repo),
      };
    },
    () => ({
      type: 'release.observed',
      repo: 'acme/lib-core',
      package: 'lib-core',
      version: `2.${random.int(10)}.0`,
    }),
    () => {
      const found = withStep();
      if (found === undefined) return undefined;
      return {
        type: 'batch.rewound',
        batchId: found[0].id,
        toStepId: found[1],
        by: 'octocat',
        via: random.pick(surfaces),
        shas: { [random.pick(repos)]: sha() },
      };
    },
    () => {
      const batch = open();
      if (batch === undefined || !random.chance(0.3)) return undefined;
      batch.open = false;
      return { type: 'batch.on_tap', batchId: batch.id, pullRequests: [pullRequest('acme/api')] };
    },
    () => {
      const batch = open();
      if (batch === undefined || !random.chance(0.2)) return undefined;
      batch.open = false;
      return {
        type: 'batch.cancelled',
        batchId: batch.id,
        by: 'octocat',
        via: random.pick(surfaces),
      };
    },
    () => {
      // An effect of an attempt scheduled earlier, at most once per key (invariant I4).
      const found = withStep();
      if (found === undefined) return undefined;
      const [batch, stepId, step] = found;
      const key = effectKey.encode({
        batchId: batch.id,
        stepId,
        attempt: random.int(step.attempt) + 1,
        effect: random.pick(effects),
      });
      if (applied.has(key)) return undefined;
      applied.add(key);
      return { type: 'effect.applied', key, result: { ok: random.chance(0.5) } };
    },
  ];

  const events: Event[] = [];
  while (events.length < length) {
    const event = random.pick(actions)();
    if (event !== undefined) events.push(event);
  }
  return events;
};

// Engine scenarios (#14): commands, supervisor ticks and what the brewer does, each chosen from the
// folded state as it is, so most commands are ones the engine accepts. A scenario is recorded as
// plain data, so a failing one can be replayed and shrunk without the generator.

/** One move of a scenario: a command for decide, or the clock moving on and a supervisor tick. */
export type Move = { kind: 'command'; command: Command } | { kind: 'tick'; advanceMs: number };

/** What the brewer does in one attempt, played by the fake runner (ADR 0028). */
export type Play =
  | { kind: 'succeed' }
  | { kind: 'fail'; retryable: boolean }
  | { kind: 'crash' }
  /** Dies with its runner: nobody renews its lease, and the supervisor loses it (ADR 0027). */
  | { kind: 'lost' }
  | { kind: 'garbage' }
  | { kind: 'missingOutDoc' }
  | { kind: 'invalidOutDoc' }
  | { kind: 'exceedBudget' }
  | { kind: 'needInput' }
  | { kind: 'denialStorm' }
  | { kind: 'blocked'; blockerKind: BlockerKind }
  /** Runs until stopped; its last file write or commit was `idleMs` before it started. */
  | { kind: 'hang'; turnsWithoutProgress: number; idleMs: number };

/**
 * A recorded scenario: the moves in order, and the play of each attempt in the order they started.
 * A play belongs to its attempt, so a scenario shrunk to fewer moves keeps what each attempt does.
 */
export interface Scenario {
  moves: Move[];
  plays: { attempt: AttemptRef; play: Play }[];
}

/** Where a scenario's moves and plays come from: a generator, or a recorded scenario. */
export interface MoveSource {
  /** The next move for `state`, or `undefined` when the scenario is over. */
  move(state: State): Move | undefined;
  /** The play of `attempt`, which starts now. */
  play(attempt: AttemptRef): Play;
}

/** The recipes of every scenario: one step without retries, two steps, and three with loops. */
export const scenarioRecipes: Readonly<Record<string, FakeRecipe>> = {
  nip: { steps: ['brew'], maxAttempts: 1 },
  pint: { steps: ['plan', 'implement'], stall: { turns: 30 } },
  growler: {
    steps: ['tests', 'implement', 'review'],
    maxAttempts: 3,
    stall: { minutes: 20 },
    routes: { implement: { failed: 'tests' }, review: { findings: 'implement' } },
  },
};

/** The limits of every attempt, so a denial storm and an exceeded budget end it (ADR 0028). */
export const scenarioLimits = { maxTurns: 40, maxDenials: 5 } as const;

/** A human issuing commands in a scenario. */
export const human = { by: 'octocat', via: 'terminal' } as const;

const minute = 60_000;
const advances = [1, 4, 6, 15, 25, 59, 61, 125].map((minutes) => minutes * minute);

/** Picks one of `choices` by weight; a choice of weight 0 is never picked. */
const weighted = <T>(random: Random, choices: readonly (readonly [number, T])[]): T => {
  const total = choices.reduce((sum, [weight]) => sum + weight, 0);
  let at = (random.int(1_000_000) / 1_000_000) * total;
  for (const [weight, choice] of choices) {
    if (at < weight) return choice;
    at -= weight;
  }
  throw new Error('Cannot pick from choices that all weigh 0');
};

/**
 * A scenario of `length` moves from `seed`: batches ordered, decomposed, routed and waiting; humans
 * answering, retrying, skipping, changing the recipe, rewinding and cancelling Stuck batches;
 * effects, some repeated and some of attempts that never existed; and the clock moving between
 * supervisor ticks, so deadlines pass, leases expire, attempts stall and reminders come due.
 */
export const generateScenario = (seed: number, length = 40): MoveSource => {
  const random = seededRandom(seed);
  const effectKeys: string[] = [];
  let moves = 0;
  let nextIssue = 1;
  let nextSubOrder = 100;

  const command = (cmd: Command): Move => ({ kind: 'command', command: cmd });
  const record = (event: RecordedEvent): Move => command({ kind: 'record', event });
  const sha = (): string => (random.int(0xfffffff) + 1).toString(16).padStart(40, '0');
  const release = {
    kind: 'release',
    repo: 'acme/lib-core',
    package: 'lib-core',
    minVersion: '2.4.0',
  } as const;

  /** A pending sub-order of a breakdown, another batch of an order, or a new order. */
  const order = (state: State): Move => {
    const pending = [...state.subOrders.values()].filter(
      (subOrder) => !subOrder.cancelled && subOrder.batchIds.length === 0,
    );
    const subOrder = pending.length > 0 && random.chance(0.6) ? random.pick(pending) : undefined;
    const parentBatchId = subOrder && state.orders.get(subOrder.order)?.batchIds[0];
    if (subOrder !== undefined && parentBatchId !== undefined) {
      const { issue } = subOrder;
      const batchId = nextBatchId(state, issue);
      return record({ type: 'batch.ordered', batchId, order: { issue }, parentBatchId });
    }
    const orders = [...state.orders.keys()];
    const issue = orders.length > 0 && random.chance(0.2) ? random.pick(orders) : nextIssue++;
    return record({ type: 'batch.ordered', batchId: nextBatchId(state, issue), order: { issue } });
  };

  /** A breakdown that keeps some sub-orders of the last one and adds new ones. */
  const decompose = (batch: Batch, state: State): Move => {
    const kept = (state.orders.get(batch.issue)?.subOrders ?? []).flatMap((issue) => {
      const subOrder = state.subOrders.get(issue);
      return subOrder !== undefined && random.chance(0.5) ? [{ issue, repo: subOrder.repo }] : [];
    });
    const fresh = Array.from({ length: random.int(2) + 1 }, () => ({
      issue: nextSubOrder++,
      repo: random.pick(repos),
    }));
    const subOrders = [...kept, ...fresh];
    const [first, second] = subOrders;
    const dependencies =
      first !== undefined && second !== undefined && random.chance(0.4)
        ? [{ subOrder: second.issue, blockedBy: first.issue, kind: 'code' as const }]
        : [];
    return record({ type: 'order.decomposed', batchId: batch.id, subOrders, dependencies });
  };

  const waitCondition = (batch: Batch, state: State): WaitCondition => {
    const siblings = [...state.batches.keys()].filter((id) => id !== batch.id);
    switch (random.int(3)) {
      case 0:
        return {
          kind: 'merge',
          pullRequest: `https://github.com/acme/api/pull/${random.int(99) + 1}`,
        };
      case 1:
        return release;
      default:
        return siblings.length > 0 ? { kind: 'sibling', batchId: random.pick(siblings) } : release;
    }
  };

  /** What a human does about a Stuck batch: what its options offer, cancelling least. */
  const unstick = (batch: Batch, state: State): Move | undefined => {
    const { lane } = batch;
    if (lane.kind !== 'stuck') return undefined;
    const batchId = batch.id;
    const action = weighted(random, [
      [lane.reason.kind === 'needs_input' ? 3 : 0, 'answer'],
      [3, 'retry'],
      [2, 'skip'],
      [1, 'recipe'],
      [1.5, 'rewind'],
      [0.5, 'cancel'],
    ] as const);
    switch (action) {
      case 'answer': {
        const questions = lane.reason.kind === 'needs_input' ? lane.reason.questions : [];
        const answers = questions.map(({ q, recommended }) => ({ q, answer: recommended }));
        return command({ kind: 'answer', batchId, ...human, answers });
      }
      case 'retry':
      case 'skip':
      case 'cancel':
        return command({ kind: action, batchId, ...human });
      case 'recipe':
        return command({
          kind: 'recipe',
          batchId,
          ...human,
          recipe: random.pick(Object.keys(scenarioRecipes)),
          reason: 'another recipe fits better',
        });
      case 'rewind': {
        const steps = scenarioRecipes[batch.recipe?.name ?? '']?.steps ?? ['plan'];
        const repo = state.subOrders.get(batch.issue)?.repo ?? random.pick(repos);
        return command({
          kind: 'rewind',
          batchId,
          ...human,
          toStepId: random.chance(0.9) ? random.pick(steps) : 'nowhere',
          shas: { [repo]: sha() },
        });
      }
      default: {
        const unhandled: never = action;
        throw new Error(`Unhandled action ${JSON.stringify(unhandled)}`);
      }
    }
  };

  /** An effect of an attempt: mostly a new key of an attempt that exists, sometimes not. */
  const effect = (state: State): Move | undefined => {
    if (effectKeys.length > 0 && random.chance(0.15)) {
      return record({ type: 'effect.applied', key: random.pick(effectKeys), result: 'again' });
    }
    const withSteps = [...state.batches.values()].filter((batch) => batch.steps.size > 0);
    if (withSteps.length === 0) return undefined;
    const batch = random.pick(withSteps);
    const [stepId, step] = random.pick([...batch.steps]);
    const latest = Math.max(...step.attempts.keys());
    const ghost = random.chance(0.1);
    const key = effectKey.encode({
      batchId: batch.id,
      stepId: ghost && random.chance(0.5) ? 'ghost' : stepId,
      attempt: ghost ? latest + 1 : random.int(latest) + 1,
      effect: random.pick(effects),
    });
    effectKeys.push(key);
    return record({ type: 'effect.applied', key, result: { ok: true } });
  };

  const next = (state: State): Move | undefined => {
    const batches = [...state.batches.values()];
    const live = batches.filter((batch) => nonTerminal.includes(batch.lane.kind));
    const inLane = (...kinds: Lane['kind'][]) =>
      live.filter((batch) => kinds.includes(batch.lane.kind));
    const unrouted = inLane('ordered', 'conditioning');
    const orders = live.filter((batch) => state.orders.has(batch.issue));
    const choice = weighted(random, [
      [batches.length < 2 ? 4 : batches.length < 6 ? 1 : 0.1, 'order'],
      [orders.length > 0 ? 0.4 : 0, 'decompose'],
      [unrouted.length > 0 ? 3 : 0, 'route'],
      [unrouted.length > 0 ? 0.7 : 0, 'wait'],
      [inLane('stuck').length > 0 ? 4 : 0, 'unstick'],
      [live.length > 0 ? 0.3 : 0, 'meddle'],
      [1, 'effect'],
      [4, 'tick'],
    ] as const);
    switch (choice) {
      case 'order':
        return order(state);
      case 'decompose':
        return decompose(random.pick(orders), state);
      case 'route':
        return command({
          kind: 'route',
          batchId: random.pick(unrouted).id,
          recipe: random.pick(Object.keys(scenarioRecipes)),
          reason: 'label',
          source: random.pick(['label', 'router'] as const),
        });
      case 'wait': {
        const batch = random.pick(unrouted);
        return command({ kind: 'wait', batchId: batch.id, on: waitCondition(batch, state) });
      }
      case 'unstick':
        return unstick(random.pick(inLane('stuck')), state);
      case 'meddle': {
        // A human command in whatever lane the batch is in: the engine refuses it or obeys.
        const kind = random.pick(['retry', 'skip', 'cancel'] as const);
        return command({ kind, batchId: random.pick(live).id, ...human });
      }
      case 'effect':
        return effect(state);
      case 'tick':
        return { kind: 'tick', advanceMs: random.pick(advances) };
      default: {
        const unhandled: never = choice;
        throw new Error(`Unhandled move ${JSON.stringify(unhandled)}`);
      }
    }
  };

  const play = (): Play =>
    weighted<Play>(random, [
      [8, { kind: 'succeed' }],
      [2, { kind: 'fail', retryable: true }],
      [0.7, { kind: 'fail', retryable: false }],
      [1, { kind: 'crash' }],
      [1.5, { kind: 'lost' }],
      [0.5, { kind: 'garbage' }],
      [0.5, { kind: 'missingOutDoc' }],
      [0.5, { kind: 'invalidOutDoc' }],
      [0.5, { kind: 'exceedBudget' }],
      [1.5, { kind: 'needInput' }],
      [1, { kind: 'denialStorm' }],
      [1, { kind: 'blocked', blockerKind: 'findings' }],
      [0.5, { kind: 'blocked', blockerKind: 'environment' }],
      [0.5, { kind: 'blocked', blockerKind: 'divergence' }],
      [2, { kind: 'hang', turnsWithoutProgress: random.int(60), idleMs: random.int(30) * minute }],
    ]);

  return {
    move: (state) => {
      // A choice with nothing to act on picks again; a tick always can.
      while (moves < length) {
        const move = next(state);
        if (move !== undefined) {
          moves++;
          return move;
        }
      }
      return undefined;
    },
    play,
  };
};

/** Records what `source` gives into `scenario`, so it can be replayed. */
export const recording = (source: MoveSource, scenario: Scenario): MoveSource => ({
  move: (state) => {
    const move = source.move(state);
    if (move !== undefined) scenario.moves.push(move);
    return move;
  },
  play: (attempt) => {
    const play = source.play(attempt);
    scenario.plays.push({ attempt, play });
    return play;
  },
});

/** Replays a recorded scenario; an attempt it has no play for succeeds. */
export const replaying = (scenario: Scenario): MoveSource => {
  let moves = 0;
  const plays = new Map(
    scenario.plays.map(({ attempt, play }) => [attemptKey.encode(attempt), play]),
  );
  return {
    move: () => scenario.moves[moves++],
    play: (attempt) => plays.get(attemptKey.encode(attempt)) ?? { kind: 'succeed' },
  };
};
