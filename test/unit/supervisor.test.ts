import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { type AttemptRef, attemptKey } from '../../src/engine/attempt-key.ts';
import type { DueBatch, Lease } from '../../src/engine/event-store.ts';
import { fold } from '../../src/engine/fold.ts';
import type { Stall } from '../../src/engine/recipes.ts';
import {
  type AttemptProgress,
  planTick,
  type TickInput,
  watchFlush,
} from '../../src/engine/supervisor.ts';
import type { Event } from '../../src/schemas/events.ts';
import { fakeRecipe, fakeRecipes } from '../helpers/fake-recipes.ts';

const minute = 60_000;
const now = new Date('2026-10-15T12:00:00.000Z');
const past = '2026-10-15T11:00:00.000Z';
const ahead = '2026-10-15T13:00:00.000Z';
const stall: Stall = { turns: 60, minutes: 20 };

const ordered = (batchId: string): Event => ({
  type: 'batch.ordered',
  batchId,
  order: { issue: Number(batchId.slice(1)) },
});
const chosen = (batchId: string, recipe = 'pint'): Event => ({
  type: 'batch.recipe_chosen',
  batchId,
  recipe,
  reason: 'feature label',
  by: 'label',
});
const scheduled = (batchId: string, deadlineAt = ahead, attempt = 1): Event => ({
  type: 'step.scheduled',
  batchId,
  stepId: 'plan',
  attempt,
  deadlineAt,
});
const started = (batchId: string, attempt = 1): Event => ({
  type: 'step.started',
  batchId,
  stepId: 'plan',
  attempt,
});
/** `batchId` brewing `recipe`, with plan#1 started and due at `deadlineAt`. */
const brewing = (batchId: string, deadlineAt = ahead, recipe = 'pint'): Event[] => [
  ordered(batchId),
  chosen(batchId, recipe),
  scheduled(batchId, deadlineAt),
  started(batchId),
];
const conditioning = (batchId: string, remindAt = past): Event[] => [
  ordered(batchId),
  {
    type: 'batch.waiting',
    batchId,
    on: { kind: 'merge', pullRequest: 'https://github.com/acme/api/pull/7' },
    remindAt,
  },
];
const stuck = (batchId: string, remindAt = past): Event[] => [
  ...brewing(batchId, past),
  {
    type: 'batch.stuck',
    batchId,
    reason: { kind: 'deadline_passed', stepId: 'plan', deadlineAt: past },
    options: ['retry', 'skip', 'recipe', 'rewind', 'cancel'],
    remindAt,
  },
];
const plan = (batchId: string, attempt = 1): AttemptRef => ({ batchId, stepId: 'plan', attempt });
const leaseOf = (ref: AttemptRef | string, expiresAt = '2026-10-15T11:59:00.000Z'): Lease => ({
  attemptKey: typeof ref === 'string' ? ref : attemptKey.encode(ref),
  owner: 'runner-1',
  expiresAt: new Date(expiresAt),
});
const dueAt = (batchId: string, deadlineAt = past): DueBatch => ({
  batchId,
  deadlineAt: new Date(deadlineAt),
});

const input = (
  events: Event[],
  extra: Partial<Omit<TickInput, 'state' | 'progress'>> & {
    progress?: Record<string, AttemptProgress>;
  } = {},
): TickInput => {
  const { progress = {}, ...rest } = extra;
  return {
    state: fold(events),
    due: [],
    expiredLeases: [],
    progress: { progress: (ref) => progress[attemptKey.encode(ref)] },
    recipes: fakeRecipes({
      pint: fakeRecipe({ steps: ['plan', 'implement'], stall }),
      calm: fakeRecipe({ steps: ['plan', 'implement'] }),
    }),
    now,
    ...rest,
  };
};
const idle = (minutesAgo: number, turns = 0): AttemptProgress => ({
  lastProgressAt: new Date(now.getTime() - minutesAgo * minute),
  turnsWithoutProgress: turns,
});
const expire = (batchId: string) =>
  ({ kind: 'expire', batchId, stepId: 'plan', attempt: 1 }) as const;
const lose = (batchId: string) =>
  ({
    kind: 'lose',
    batchId,
    stepId: 'plan',
    attempt: 1,
    reason: 'the lease of runner-1 expired at 2026-10-15T11:59:00.000Z',
  }) as const;

describe('planTick: deadlines (invariant I5)', () => {
  it('expires the running attempt of a brewing batch that is past its deadline', () => {
    const tick = planTick(input(brewing('b1', past), { due: [dueAt('b1')] }));
    assert.deepStrictEqual(tick, { commands: [expire('b1')], releaseLeases: [] });
  });

  it('expires an attempt whose deadline is now, as the store counts it due', () => {
    const atNow = now.toISOString();
    const tick = planTick(input(brewing('b1', atNow), { due: [dueAt('b1', atNow)] }));
    assert.deepStrictEqual(tick.commands, [expire('b1')]);
  });

  it('expires a scheduled attempt that never started', () => {
    const events = [ordered('b1'), chosen('b1'), scheduled('b1', past)];
    const tick = planTick(input(events, { due: [dueAt('b1')] }));
    assert.deepStrictEqual(tick.commands, [expire('b1')]);
  });

  it('expires the running step, not an earlier step that finished, and loses nothing for it', () => {
    const events: Event[] = [
      ordered('b1'),
      chosen('b1'),
      scheduled('b1', '2026-10-15T10:00:00.000Z'),
      started('b1'),
      {
        type: 'step.finished',
        batchId: 'b1',
        stepId: 'plan',
        attempt: 1,
        outcome: { kind: 'succeeded', output: null },
      },
      { type: 'step.scheduled', batchId: 'b1', stepId: 'implement', attempt: 1, deadlineAt: past },
      { type: 'step.started', batchId: 'b1', stepId: 'implement', attempt: 1 },
    ];
    const lease = leaseOf(plan('b1'));
    const tick = planTick(input(events, { due: [dueAt('b1')], expiredLeases: [lease] }));
    assert.deepStrictEqual(tick, {
      commands: [{ kind: 'expire', batchId: 'b1', stepId: 'implement', attempt: 1 }],
      releaseLeases: [lease.attemptKey],
    });
  });

  it('expires the attempt that was due first when two attempts of a batch are late', () => {
    const events: Event[] = [
      ...brewing('b1', '2026-10-15T10:30:00.000Z'),
      { type: 'step.scheduled', batchId: 'b1', stepId: 'implement', attempt: 1, deadlineAt: past },
      { type: 'step.started', batchId: 'b1', stepId: 'implement', attempt: 1 },
    ];
    const tick = planTick(input(events, { due: [dueAt('b1', '2026-10-15T10:30:00.000Z')] }));
    assert.deepStrictEqual(tick.commands, [expire('b1')]);
  });

  it('follows the folded state when the index names a batch whose attempt is not due', () => {
    const tick = planTick(input(brewing('b1', ahead), { due: [dueAt('b1')] }));
    assert.deepStrictEqual(tick.commands, []);
  });

  it('ignores a due batch the state does not know', () => {
    assert.deepStrictEqual(planTick(input([], { due: [dueAt('b9')] })).commands, []);
  });

  it('issues one command per batch, in the order the store lists them', () => {
    const events = [...brewing('b2', past), ...brewing('b1', past), ...conditioning('b3')];
    const due = [dueAt('b2'), dueAt('b3'), dueAt('b1')];
    const tick = planTick(input(events, { due }));
    assert.deepStrictEqual(tick.commands, [
      expire('b2'),
      { kind: 'remind', batchId: 'b3' },
      expire('b1'),
    ]);
  });
});

describe('planTick: reminders (ADR 0025)', () => {
  it('reminds a Conditioning batch whose reminder is due', () => {
    const tick = planTick(input(conditioning('b1'), { due: [dueAt('b1')] }));
    assert.deepStrictEqual(tick.commands, [{ kind: 'remind', batchId: 'b1' }]);
  });

  it('reminds a Stuck batch whose reminder is due', () => {
    const tick = planTick(input(stuck('b1'), { due: [dueAt('b1')] }));
    assert.deepStrictEqual(tick.commands, [{ kind: 'remind', batchId: 'b1' }]);
  });

  it('leaves a reminder that is not due yet', () => {
    const tick = planTick(input(stuck('b1', ahead), { due: [dueAt('b1')] }));
    assert.deepStrictEqual(tick.commands, []);
  });

  it('leaves a batch on tap or cancelled', () => {
    const cancelled: Event[] = [
      ...brewing('b1', past),
      { type: 'batch.cancelled', batchId: 'b1', by: 'octocat', via: 'plugin' },
    ];
    assert.deepStrictEqual(planTick(input(cancelled, { due: [dueAt('b1')] })).commands, []);
  });
});

describe('planTick: expired leases (ADR 0027)', () => {
  it('loses the started attempt whose lease expired, and releases the lease', () => {
    const lease = leaseOf(plan('b1'));
    const tick = planTick(input(brewing('b1'), { expiredLeases: [lease] }));
    assert.deepStrictEqual(tick, { commands: [lose('b1')], releaseLeases: [lease.attemptKey] });
  });

  it('only releases the lease of an attempt that has not started: its deadline covers it', () => {
    const lease = leaseOf(plan('b1'));
    const events = [ordered('b1'), chosen('b1'), scheduled('b1')];
    const tick = planTick(input(events, { expiredLeases: [lease] }));
    assert.deepStrictEqual(tick, { commands: [], releaseLeases: [lease.attemptKey] });
  });

  it('only releases the lease of an attempt a later attempt replaced', () => {
    const lease = leaseOf(plan('b1'));
    const events: Event[] = [
      ...brewing('b1'),
      {
        type: 'step.finished',
        batchId: 'b1',
        stepId: 'plan',
        attempt: 1,
        outcome: { kind: 'cancelled' },
      },
      scheduled('b1', ahead, 2),
      started('b1', 2),
    ];
    const tick = planTick(input(events, { expiredLeases: [lease] }));
    assert.deepStrictEqual(tick, { commands: [], releaseLeases: [lease.attemptKey] });
  });

  it('only releases the lease of an attempt abandoned when its batch got Stuck', () => {
    const lease = leaseOf(plan('b1'));
    const tick = planTick(input(stuck('b1', ahead), { expiredLeases: [lease] }));
    assert.deepStrictEqual(tick, { commands: [], releaseLeases: [lease.attemptKey] });
  });

  for (const key of ['b1/plan#1', attemptKey.encode(plan('b9'))]) {
    it(`only releases a lease of an attempt the state does not know: ${key}`, () => {
      const tick = planTick(input(brewing('b1'), { expiredLeases: [leaseOf(key)] }));
      assert.deepStrictEqual(tick, { commands: [], releaseLeases: [key] });
    });
  }

  it('expires rather than loses an attempt that is also past its deadline (invariant I5)', () => {
    const lease = leaseOf(plan('b1'));
    const tick = planTick(
      input(brewing('b1', past), { due: [dueAt('b1')], expiredLeases: [lease] }),
    );
    assert.deepStrictEqual(tick, { commands: [expire('b1')], releaseLeases: [lease.attemptKey] });
  });
});

describe('planTick: stalls (ADR 0027)', () => {
  const stalled = (lastProgressAt: Date, turnsWithoutProgress: number) =>
    ({
      kind: 'stall',
      batchId: 'b1',
      stepId: 'plan',
      attempt: 1,
      lastProgressAt,
      turnsWithoutProgress,
    }) as const;
  const progressOf = (progress: AttemptProgress) => ({
    progress: { [attemptKey.encode(plan('b1'))]: progress },
  });

  it('stalls an attempt without progress for the recipe turns', () => {
    const progress = idle(1, 60);
    const tick = planTick(input(brewing('b1'), progressOf(progress)));
    assert.deepStrictEqual(tick.commands, [stalled(progress.lastProgressAt, 60)]);
  });

  it('stalls an attempt without progress for the recipe minutes', () => {
    const progress = idle(20, 3);
    const tick = planTick(input(brewing('b1'), progressOf(progress)));
    assert.deepStrictEqual(tick.commands, [stalled(progress.lastProgressAt, 3)]);
  });

  it('leaves an attempt under both limits', () => {
    const tick = planTick(input(brewing('b1'), progressOf(idle(19, 59))));
    assert.deepStrictEqual(tick.commands, []);
  });

  it('leaves an attempt whose recipe has no stall limit', () => {
    const tick = planTick(input(brewing('b1', ahead, 'calm'), progressOf(idle(600, 600))));
    assert.deepStrictEqual(tick.commands, []);
  });

  for (const [what, limit] of [
    ['turns', { turns: 60 }],
    ['minutes', { minutes: 20 }],
  ] as const) {
    it(`stalls on ${what} alone when the recipe sets only ${what}`, () => {
      const progress = idle(20, 60);
      const tick = planTick({
        ...input(brewing('b1'), progressOf(progress)),
        recipes: fakeRecipes({ pint: fakeRecipe({ steps: ['plan'], stall: limit }) }),
      });
      assert.deepStrictEqual(tick.commands, [stalled(progress.lastProgressAt, 60)]);
      const under = planTick({
        ...input(brewing('b1'), progressOf(what === 'turns' ? idle(600, 59) : idle(19, 600))),
        recipes: fakeRecipes({ pint: fakeRecipe({ steps: ['plan'], stall: limit }) }),
      });
      assert.deepStrictEqual(under.commands, []);
    });
  }

  it('leaves an attempt the runner reports nothing about', () => {
    assert.deepStrictEqual(planTick(input(brewing('b1'))).commands, []);
  });

  it('leaves an attempt that has not started', () => {
    const events = [ordered('b1'), chosen('b1'), scheduled('b1')];
    assert.deepStrictEqual(planTick(input(events, progressOf(idle(600, 600)))).commands, []);
  });

  it('leaves a batch whose recipe the Brewery no longer has', () => {
    const tick = planTick(input(brewing('b1', ahead, 'gone'), progressOf(idle(600, 600))));
    assert.deepStrictEqual(tick.commands, []);
  });

  it('loses rather than stalls an attempt whose lease also expired', () => {
    const lease = leaseOf(plan('b1'));
    const tick = planTick(
      input(brewing('b1'), { ...progressOf(idle(600, 600)), expiredLeases: [lease] }),
    );
    assert.deepStrictEqual(tick.commands, [lose('b1')]);
  });

  it('expires rather than stalls an attempt past its deadline (invariant I5)', () => {
    const tick = planTick(
      input(brewing('b1', past), { ...progressOf(idle(600, 600)), due: [dueAt('b1')] }),
    );
    assert.deepStrictEqual(tick.commands, [expire('b1')]);
  });
});

describe('watchFlush (ADR 0024)', () => {
  const deadline = 10 * minute;
  const at = (minutes: number) => new Date(now.getTime() + minutes * minute);

  it('starts watching at the first failed flush', () => {
    assert.deepStrictEqual(watchFlush(undefined, 'failed', now, deadline), {
      watch: { failingSince: now, reported: false },
    });
  });

  it('keeps the time of the first failure while flushes keep failing', () => {
    const watch = { failingSince: now, reported: false };
    assert.deepStrictEqual(watchFlush(watch, 'failed', at(5), deadline), { watch });
  });

  it('reports once when the flushes still fail at the deadline', () => {
    const watch = { failingSince: now, reported: false };
    const reported = { failingSince: now, reported: true };
    assert.deepStrictEqual(watchFlush(watch, 'failed', at(10), deadline), {
      watch: reported,
      overdueSince: now,
    });
    assert.deepStrictEqual(watchFlush(reported, 'failed', at(20), deadline), { watch: reported });
  });

  for (const outcome of ['pushed', 'unchanged'] as const) {
    it(`stops watching when a flush is ${outcome}`, () => {
      const watch = { failingSince: now, reported: true };
      assert.deepStrictEqual(watchFlush(watch, outcome, at(30), deadline), { watch: undefined });
    });
  }
});
