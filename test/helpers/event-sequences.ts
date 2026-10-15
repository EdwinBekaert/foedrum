// A seeded generator of valid event sequences for property tests (architecture §9).
// The same seed always gives the same events, so a failing seed can be replayed.

import type { Event, StuckOption, StuckReason, WaitCondition } from '../../src/schemas/events.ts';
import type { StepOutcome } from '../../src/schemas/step-outcome.ts';

interface Random {
  /** An integer in [0, max). */
  int: (max: number) => number;
  pick: <T>(items: readonly T[]) => T;
  chance: (p: number) => boolean;
}

/** mulberry32: small, fast and good enough to explore event orders. */
const seededRandom = (seed: number): Random => {
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
    switch (random.int(5)) {
      case 0:
        return { kind: 'needs_input', stepId, questions: [question] };
      case 1:
        return { kind: 'blocked', stepId, blockerKind: 'environment', summary: 'CI is down' };
      case 2:
        return { kind: 'attempts_exhausted', stepId, attempts: 3, lastReason: 'tests fail' };
      case 3:
        return { kind: 'deadline_passed', stepId, deadlineAt: timestamp() };
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
      return {
        type: 'batch.recipe_chosen',
        batchId: batch.id,
        recipe: random.pick(['nip', 'pint', 'growler']),
        reason: 'label',
        by: random.pick(['label', 'router', 'human'] as const),
      };
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
      return { type: 'batch.cancelled', batchId: batch.id, by: 'octocat' };
    },
    () => ({
      type: 'effect.applied',
      key: `effect${nextId++}`,
      result: { ok: random.chance(0.5) },
    }),
  ];

  const events: Event[] = [];
  while (events.length < length) {
    const event = random.pick(actions)();
    if (event !== undefined) events.push(event);
  }
  return events;
};
