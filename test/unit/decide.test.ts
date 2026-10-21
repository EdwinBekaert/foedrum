import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  type Command,
  type Context,
  decide,
  type RecordedEvent,
  stuckOptions,
} from '../../src/engine/decide.ts';
import { effectKey } from '../../src/engine/effect-key.ts';
import { fold, type Lane, type State } from '../../src/engine/fold.ts';
import { loadRecipes } from '../../src/engine/recipe-files.ts';
import type {
  Event,
  OrderRef,
  StuckOption,
  StuckReason,
  WaitCondition,
} from '../../src/schemas/events.ts';
import type { StepOutcome } from '../../src/schemas/step-outcome.ts';
import { brewerText, recipeText } from '../helpers/brewery-files.ts';
import { fakeRecipe, fakeRecipes, hour } from '../helpers/fake-recipes.ts';

const day = 24 * hour;
const now = new Date('2026-10-15T12:00:00.000Z');
const inAnHour = '2026-10-15T13:00:00.000Z';
const inTwoDays = '2026-10-17T12:00:00.000Z';
const pullRequest = 'https://github.com/acme/api/pull/7';
const sha = 'a'.repeat(40);
const question = {
  q: 'Keep the v1 endpoint?',
  options: ['keep', 'remove'],
  recommended: 'keep',
  whyBlocking: 'Removing it breaks the mobile app',
};
const all = ['answer', 'retry', 'skip', 'recipe', 'rewind', 'cancel'] as const;
const withoutAnswer = ['retry', 'skip', 'recipe', 'rewind', 'cancel'] as const;

const context: Context = {
  now,
  reminderMs: 2 * day,
  routingMs: hour,
  recipes: fakeRecipes({
    pint: fakeRecipe({
      steps: ['plan', 'implement', 'green'],
      routes: { green: { failed: 'implement' }, implement: { findings: 'plan' } },
      pullRequests: [pullRequest],
    }),
    nip: fakeRecipe({ steps: ['patch'], pullRequests: [pullRequest] }),
  }),
};
const by = { by: 'octocat', via: 'comment' } as const;

const ordered: Event = {
  type: 'batch.ordered',
  batchId: 'b1',
  order: { issue: 100 },
  routeBy: '2026-12-31T00:00:00.000Z',
};
const chosen = (recipe = 'pint'): Event => ({
  type: 'batch.recipe_chosen',
  batchId: 'b1',
  recipe,
  reason: 'feature label',
  source: 'label',
});
const scheduled = (
  stepId: string,
  attempt = 1,
  deadlineAt = '2026-10-15T11:00:00.000Z',
): Extract<Event, { type: 'step.scheduled' }> => ({
  type: 'step.scheduled',
  batchId: 'b1',
  stepId,
  attempt,
  deadlineAt,
});
const started = (stepId: string, attempt = 1): Event => ({
  type: 'step.started',
  batchId: 'b1',
  stepId,
  attempt,
});
const failed = (stepId: string, attempt: number): Event => ({
  type: 'step.finished',
  batchId: 'b1',
  stepId,
  attempt,
  outcome: { kind: 'failed', retryable: true, reason: 'tests fail' },
});
/** Batch b1 brewing `recipe`, with `stepId` at `attempt` running and the earlier attempts failed. */
const brewing = (stepId = 'plan', attempt = 1, recipe = 'pint'): Event[] => [
  ordered,
  chosen(recipe),
  ...Array.from({ length: attempt - 1 }, (_, i) => [
    scheduled(stepId, i + 1),
    started(stepId, i + 1),
    failed(stepId, i + 1),
  ]).flat(),
  scheduled(stepId, attempt),
  started(stepId, attempt),
];
const stuckEvent = (reason: StuckReason, options: readonly StuckOption[] = all): Event => ({
  type: 'batch.stuck',
  batchId: 'b1',
  reason,
  options: [...options],
  remindAt: '2026-10-16T12:00:00.000Z',
});
const needsInput: StuckReason = { kind: 'needs_input', stepId: 'plan', questions: [question] };
const stuck = (reason: StuckReason = needsInput, options: readonly StuckOption[] = all) => [
  ...brewing(),
  stuckEvent(reason, options),
];
const merge: WaitCondition = { kind: 'merge', pullRequest };
const conditioning: Event[] = [
  ordered,
  { type: 'batch.waiting', batchId: 'b1', on: merge, remindAt: '2026-10-15T11:00:00.000Z' },
];
const onTap: Event[] = [
  ...brewing(),
  {
    type: 'step.finished',
    batchId: 'b1',
    stepId: 'plan',
    attempt: 1,
    outcome: { kind: 'succeeded', output: null },
  },
  { type: 'batch.on_tap', batchId: 'b1', pullRequests: [pullRequest] },
];
const cancelled: Event[] = [
  ...brewing(),
  { type: 'batch.cancelled', batchId: 'b1', by: 'octocat', via: 'plugin' },
];
/** A log that leaves batch b1 in each lane. */
const lanes: Record<Lane['kind'], Event[]> = {
  ordered: [ordered],
  brewing: brewing(),
  conditioning,
  stuck: stuck(),
  on_tap: onTap,
  cancelled,
};

const accepts = (events: Event[], command: Command, expected: Event[]): void => {
  assert.deepStrictEqual(decide(fold(events), command, context), {
    kind: 'accepted',
    events: expected,
  });
};
const refuses = (events: Event[] | State, command: Command, reason: RegExp): void => {
  const decision = decide(Array.isArray(events) ? fold(events) : events, command, context);
  assert.equal(decision.kind, 'refused', JSON.stringify(decision));
  assert.match(decision.kind === 'refused' ? decision.reason : '', reason);
};
const otherLanes = (...allowed: Lane['kind'][]) =>
  Object.entries(lanes).filter(([lane]) => !allowed.includes(lane as Lane['kind']));

const stuckOn = (
  reason: StuckReason,
  options: readonly StuckOption[] = reason.kind === 'needs_input' ? all : withoutAnswer,
): Event => ({
  type: 'batch.stuck',
  batchId: 'b1',
  reason,
  options: [...options],
  remindAt: inTwoDays,
});
const next = (stepId: string, attempt = 1) => scheduled(stepId, attempt, inAnHour);

describe('stuckOptions', () => {
  it('offers answer only when the batch waits for answers', () => {
    assert.deepStrictEqual(stuckOptions(needsInput), [...all]);
  });

  const others: StuckReason[] = [
    { kind: 'blocked', stepId: 'plan', blockerKind: 'environment', summary: 'CI is down' },
    { kind: 'attempts_exhausted', stepId: 'plan', attempts: 2, lastReason: 'tests fail' },
    { kind: 'deadline_passed', stepId: 'plan', deadlineAt: inAnHour },
    { kind: 'waiting_for_session', stepId: 'plan' },
    {
      kind: 'stalled',
      stepId: 'plan',
      lastProgressAt: '2026-10-15T11:40:00.000Z',
      turnsWithoutProgress: 60,
    },
  ];
  for (const reason of others) {
    it(`offers every option but answer for ${reason.kind}`, () => {
      assert.deepStrictEqual(stuckOptions(reason), [...withoutAnswer]);
    });
  }
});

describe('decide', () => {
  it('refuses a command for a batch that was never ordered', () => {
    refuses([], { kind: 'cancel', batchId: 'b1', ...by }, /batch b1 was never ordered/);
  });
});

describe('decide record', () => {
  it('appends the event', () => {
    const observed: RecordedEvent = {
      type: 'release.observed',
      repo: 'acme/lib-core',
      package: 'lib-core',
      version: '2.4.0',
    };
    accepts([], { kind: 'record', event: observed }, [observed]);
  });

  it('refuses an event the lane does not allow', () => {
    refuses(
      lanes.stuck,
      { kind: 'record', event: started('plan', 1) as Extract<Event, { type: 'step.started' }> },
      /batch b1 is stuck; step.started needs it brewing/,
    );
  });

  it('refuses an event the fold would throw on', () => {
    const decomposed: RecordedEvent = {
      type: 'order.decomposed',
      batchId: 'b1',
      subOrders: [{ issue: 101, repo: 'acme/api' }],
      dependencies: [],
    };
    refuses([], { kind: 'record', event: decomposed }, /batch b1 was never ordered/);
  });
});

describe('decide order and unrouted: a routing deadline (ADR 0032)', () => {
  const late: Event = { ...ordered, routeBy: '2026-10-15T11:00:00.000Z' };
  const routing: StuckReason = { kind: 'routing', deadlineAt: '2026-10-15T11:00:00.000Z' };
  const unroutable = ['retry', 'recipe', 'cancel'] as const;
  const stuckOnRouting = [late, stuckOn(routing, unroutable)];

  it('orders a batch, to be routed within the routing interval', () => {
    accepts([], { kind: 'order', batchId: 'b1', order: { issue: 100 } }, [
      { type: 'batch.ordered', batchId: 'b1', order: { issue: 100 }, routeBy: inAnHour },
    ]);
  });

  it('orders the batch of a sub-order with its parent batch', () => {
    accepts(
      [ordered],
      { kind: 'order', batchId: 'b2', order: { issue: 101 }, parentBatchId: 'b1' },
      [
        {
          type: 'batch.ordered',
          batchId: 'b2',
          order: { issue: 101 },
          parentBatchId: 'b1',
          routeBy: inAnHour,
        },
      ],
    );
  });

  it('refuses a batch ordered twice', () => {
    refuses([ordered], { kind: 'order', batchId: 'b1', order: { issue: 100 } }, /already ordered/);
  });

  it('offers retry, recipe and cancel for a batch Stuck on routing', () => {
    assert.deepStrictEqual(stuckOptions(routing), [...unroutable]);
  });

  it('makes an Ordered batch past its routing deadline Stuck on routing', () => {
    accepts([late], { kind: 'unrouted', batchId: 'b1' }, [stuckOn(routing, unroutable)]);
  });

  it('refuses an Ordered batch whose routing deadline is ahead', () => {
    refuses(
      [ordered],
      { kind: 'unrouted', batchId: 'b1' },
      /batch b1 is not due to be routed until 2026-12-31T00:00:00.000Z/,
    );
  });

  for (const [lane, events] of otherLanes('ordered')) {
    it(`refuses unrouted when the batch is ${lane}`, () => {
      refuses(events, { kind: 'unrouted', batchId: 'b1' }, /unrouted needs it ordered/);
    });
  }

  it('sends a batch Stuck on routing back to Ordered on retry, with a new routing deadline', () => {
    const retry: Command = { kind: 'retry', batchId: 'b1', ...by };
    accepts(stuckOnRouting, retry, [
      { type: 'batch.resumed', batchId: 'b1', ...by, action: 'retry', routeBy: inAnHour },
    ]);
  });

  it('brews a batch Stuck on routing once a human chooses its recipe', () => {
    const recipe: Command = { kind: 'recipe', batchId: 'b1', ...by, recipe: 'pint', reason: 'r' };
    accepts(stuckOnRouting, recipe, [
      {
        type: 'batch.recipe_chosen',
        batchId: 'b1',
        recipe: 'pint',
        reason: 'r',
        source: 'human',
        ...by,
      },
      { type: 'batch.resumed', batchId: 'b1', ...by, action: 'recipe' },
      next('plan'),
    ]);
  });

  it('refuses to skip for a batch Stuck on routing: it has no step', () => {
    const skip: Command = { kind: 'skip', batchId: 'b1', ...by };
    refuses(stuckOnRouting, skip, /batch b1 does not offer skip/);
    refuses([late, stuckOn(routing, ['skip', 'cancel'])], skip, /batch b1 has no step to skip/);
  });
});

describe('decide route: ordered or conditioning → brewing', () => {
  const route: Command = {
    kind: 'route',
    batchId: 'b1',
    recipe: 'pint',
    reason: 'small',
    source: 'router',
  };
  const routed: Event[] = [
    {
      type: 'batch.recipe_chosen',
      batchId: 'b1',
      recipe: 'pint',
      reason: 'small',
      source: 'router',
    },
    next('plan'),
  ];

  it('chooses the recipe and schedules its first step', () => {
    accepts(lanes.ordered, route, routed);
  });

  it('ends Conditioning', () => {
    accepts(lanes.conditioning, route, routed);
  });

  it('refuses a recipe the Brewery does not have', () => {
    refuses(lanes.ordered, { ...route, recipe: 'stout' }, /the Brewery has no recipe stout/);
  });

  for (const [lane, events] of otherLanes('ordered', 'conditioning')) {
    it(`refuses a batch that is ${lane}`, () => {
      refuses(
        events,
        route,
        new RegExp(`batch b1 is ${lane}; route needs it ordered or conditioning`),
      );
    });
  }
});

describe('decide finish', () => {
  const finish = (
    ending: Extract<Command, { kind: 'finish' }>['ending'],
    stepId = 'plan',
    attempt = 1,
  ): Command => ({
    kind: 'finish',
    batchId: 'b1',
    stepId,
    attempt,
    ending,
  });
  const finished = (outcome: StepOutcome, stepId = 'plan', attempt = 1): Event => ({
    type: 'step.finished',
    batchId: 'b1',
    stepId,
    attempt,
    outcome,
  });
  const succeeded = { kind: 'succeeded', output: { plan: 'ok' } } as const;
  const retryable = { kind: 'failed', retryable: true, reason: 'out doc missing' } as const;
  const final = { kind: 'failed', retryable: false, reason: 'tests fail' } as const;

  it('schedules the next step when a step succeeded', () => {
    accepts(brewing(), finish(succeeded), [finished(succeeded), next('implement')]);
  });

  it('records the usage of the attempt', () => {
    const usage = { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 1 };
    const decision = decide(fold(brewing()), { ...finish(succeeded), usage } as Command, context);
    assert.deepStrictEqual(decision.kind === 'accepted' && decision.events[0], {
      ...finished(succeeded),
      usage,
    });
  });

  it('records the gravity readings of a check attempt (ADR 0069)', () => {
    const readings = [
      { result: 'skipped', check: 'lint' },
      { result: 'exited', check: 'test', command: 'npm test', exitCode: 1, tail: 'not ok 1' },
    ] as const;
    const decision = decide(fold(brewing()), { ...finish(final), readings } as Command, context);
    assert.deepStrictEqual(decision.kind === 'accepted' && decision.events[0], {
      ...finished(final),
      readings,
    });
  });

  it('puts the batch on tap when the last step succeeded', () => {
    accepts(brewing('patch', 1, 'nip'), finish(succeeded, 'patch'), [
      finished(succeeded, 'patch'),
      { type: 'batch.on_tap', batchId: 'b1', pullRequests: [pullRequest] },
    ]);
  });

  it('retries a retryable failure while the step has attempts left', () => {
    accepts(brewing(), finish(retryable), [finished(retryable), next('plan', 2)]);
  });

  it('makes the batch Stuck when a retryable failure has no attempts left', () => {
    accepts(brewing('plan', 2), finish(retryable, 'plan', 2), [
      finished(retryable, 'plan', 2),
      stuckOn({
        kind: 'attempts_exhausted',
        stepId: 'plan',
        attempts: 2,
        lastReason: 'out doc missing',
      }),
    ]);
  });

  it('sends a failed check back along its route, recording the route on the schedule', () => {
    accepts(brewing('green'), finish(final, 'green'), [
      finished(final, 'green'),
      { ...next('implement'), route: { from: 'green', why: 'failed' } },
    ]);
  });

  it('retries a retryable failure of a step with a route while it has attempts left', () => {
    accepts(brewing('green'), finish(retryable, 'green'), [
      finished(retryable, 'green'),
      next('green', 2),
    ]);
  });

  it('sends a retryable failure back along its route once the attempts are used up', () => {
    accepts(brewing('green', 2), finish(retryable, 'green', 2), [
      finished(retryable, 'green', 2),
      { ...next('implement'), route: { from: 'green', why: 'failed' } },
    ]);
  });

  it('never sends a cancelled attempt along a route', () => {
    const cancel = { kind: 'cancelled' } as const;
    accepts(brewing('green', 2), finish(cancel, 'green', 2), [
      finished(cancel, 'green', 2),
      stuckOn({
        kind: 'attempts_exhausted',
        stepId: 'green',
        attempts: 2,
        lastReason: 'the attempt was cancelled',
      }),
    ]);
  });

  it('makes the batch Stuck when a final failure has no route', () => {
    accepts(brewing(), finish(final), [
      finished(final),
      stuckOn({
        kind: 'attempts_exhausted',
        stepId: 'plan',
        attempts: 1,
        lastReason: 'tests fail',
      }),
    ]);
  });

  it('makes the batch Stuck with the questions of needs_input', () => {
    const needs: StepOutcome = { kind: 'needs_input', questions: [question] };
    accepts(brewing(), finish(needs), [finished(needs), stuckOn(needsInput)]);
  });

  it('retries a cancelled attempt while the step has attempts left', () => {
    const cancel = { kind: 'cancelled' } as const;
    accepts(brewing(), finish(cancel), [finished(cancel), next('plan', 2)]);
  });

  it('makes the batch Stuck when a cancelled attempt has no attempts left', () => {
    const cancel = { kind: 'cancelled' } as const;
    accepts(brewing('plan', 2), finish(cancel, 'plan', 2), [
      finished(cancel, 'plan', 2),
      stuckOn({
        kind: 'attempts_exhausted',
        stepId: 'plan',
        attempts: 2,
        lastReason: 'the attempt was cancelled',
      }),
    ]);
  });

  describe('a blocked out doc', () => {
    const blocked = (blockerKind: 'findings' | 'environment' | 'divergence') =>
      ({ kind: 'blocked', blockerKind, summary: 'the test is wrong' }) as const;
    const recorded = (blockerKind: string) =>
      ({
        kind: 'failed',
        retryable: false,
        reason: `blocked (${blockerKind}): the test is wrong`,
      }) as const;

    it('is recorded as a final failure, and findings go back along the route', () => {
      accepts(brewing('implement'), finish(blocked('findings'), 'implement'), [
        finished(recorded('findings'), 'implement'),
        { ...next('plan'), route: { from: 'implement', why: 'findings' } },
      ]);
    });

    it('with findings and no route makes the batch Stuck', () => {
      accepts(brewing(), finish(blocked('findings')), [
        finished(recorded('findings')),
        stuckOn({
          kind: 'blocked',
          stepId: 'plan',
          blockerKind: 'findings',
          summary: 'the test is wrong',
        }),
      ]);
    });

    for (const blockerKind of ['environment', 'divergence'] as const) {
      it(`with ${blockerKind} makes the batch Stuck at once, even with a route`, () => {
        accepts(brewing('implement'), finish(blocked(blockerKind), 'implement'), [
          finished(recorded(blockerKind), 'implement'),
          stuckOn({
            kind: 'blocked',
            stepId: 'implement',
            blockerKind,
            summary: 'the test is wrong',
          }),
        ]);
      });
    }
  });

  it('refuses an attempt that is not the latest of its step', () => {
    const retried = [...brewing(), failed('plan', 1), next('plan', 2)];
    refuses(
      retried,
      finish(succeeded),
      /attempt plan#1 of batch b1 is not the latest attempt of its step/,
    );
  });

  it('refuses a batch without a recipe', () => {
    refuses(
      [ordered, scheduled('plan'), started('plan')],
      finish(succeeded),
      /batch b1 has no recipe/,
    );
  });

  it('refuses a recipe the Brewery no longer has', () => {
    refuses(brewing('plan', 1, 'stout'), finish(succeeded), /the Brewery has no recipe stout/);
  });

  for (const [lane, events] of otherLanes('brewing')) {
    it(`refuses a batch that is ${lane}`, () => {
      refuses(
        events,
        finish(succeeded),
        new RegExp(`batch b1 is ${lane}; finish needs it brewing`),
      );
    });
  }
});

describe('decide expire: brewing → Stuck (invariant I5)', () => {
  const expire: Command = { kind: 'expire', batchId: 'b1', stepId: 'plan', attempt: 1 };

  it('makes the batch Stuck when the attempt is past its deadline', () => {
    accepts(brewing(), expire, [
      stuckOn({ kind: 'deadline_passed', stepId: 'plan', deadlineAt: '2026-10-15T11:00:00.000Z' }),
    ]);
  });

  it('makes the batch Stuck when the deadline is now, as the store counts it due', () => {
    const atNow = now.toISOString();
    accepts([ordered, chosen(), scheduled('plan', 1, atNow), started('plan')], expire, [
      stuckOn({ kind: 'deadline_passed', stepId: 'plan', deadlineAt: atNow }),
    ]);
  });

  it('refuses an attempt whose deadline is still ahead', () => {
    const events = [ordered, chosen(), scheduled('plan', 1, inAnHour), started('plan')];
    refuses(events, expire, /attempt plan#1 of batch b1 is not due until 2026-10-15T13:00:00.000Z/);
  });

  it('refuses an attempt that finished', () => {
    refuses(
      [...brewing(), failed('plan', 1), scheduled('plan', 2)],
      expire,
      /attempt plan#1 of batch b1 is not running/,
    );
  });

  it('refuses the latest attempt of a step once it finished', () => {
    const succeeded: Event = {
      type: 'step.finished',
      batchId: 'b1',
      stepId: 'plan',
      attempt: 1,
      outcome: { kind: 'succeeded', output: null },
    };
    refuses(
      [...brewing(), succeeded, next('implement')],
      expire,
      /attempt plan#1 of batch b1 is not running/,
    );
  });

  it('refuses an attempt a later attempt of its step replaced', () => {
    refuses(
      [ordered, chosen(), scheduled('plan', 1), scheduled('plan', 2)],
      expire,
      /attempt plan#1 of batch b1 is not running/,
    );
  });

  it('refuses an attempt that was never scheduled', () => {
    refuses(brewing(), { ...expire, attempt: 3 }, /attempt plan#3 of batch b1 is not running/);
  });

  it('refuses, after a skip, the attempt that expired, and its late finish (ADR 0025)', () => {
    let state = fold(brewing());
    for (const command of [expire, { kind: 'skip', batchId: 'b1', ...by }] as Command[]) {
      const decision = decide(state, command, context);
      assert.equal(decision.kind, 'accepted', JSON.stringify(decision));
      if (decision.kind === 'accepted') state = fold(decision.events, state);
    }
    refuses(state, expire, /attempt plan#1 of batch b1 is not running/);
    const late: Command = {
      kind: 'finish',
      batchId: 'b1',
      stepId: 'plan',
      attempt: 1,
      ending: { kind: 'succeeded', output: null },
    };
    refuses(state, late, /attempt plan#1 of batch b1 was abandoned when the batch got stuck/);
  });

  for (const [lane, events] of otherLanes('brewing')) {
    it(`refuses a batch that is ${lane}`, () => {
      refuses(events, expire, new RegExp(`batch b1 is ${lane}; expire needs it brewing`));
    });
  }
});

describe('decide lose: a lost attempt is retried (ADR 0027)', () => {
  const lose = (stepId = 'plan', attempt = 1): Command => ({
    kind: 'lose',
    batchId: 'b1',
    stepId,
    attempt,
    reason: 'the lease of runner-1 expired at 2026-10-15T11:59:00.000Z',
  });
  const lastReason =
    'the attempt was lost: the lease of runner-1 expired at 2026-10-15T11:59:00.000Z';
  const lost = (stepId = 'plan', attempt = 1): Event => ({
    type: 'step.finished',
    batchId: 'b1',
    stepId,
    attempt,
    outcome: { kind: 'failed', retryable: true, reason: lastReason },
  });

  it('records the attempt as a retryable failure and schedules the next attempt', () => {
    accepts(brewing(), lose(), [lost(), next('plan', 2)]);
  });

  it('makes the batch Stuck when the step has no attempts left', () => {
    accepts(brewing('plan', 2), lose('plan', 2), [
      lost('plan', 2),
      stuckOn({ kind: 'attempts_exhausted', stepId: 'plan', attempts: 2, lastReason }),
    ]);
  });

  it('never sends a lost attempt along a route', () => {
    accepts(brewing('green', 2), lose('green', 2), [
      lost('green', 2),
      stuckOn({ kind: 'attempts_exhausted', stepId: 'green', attempts: 2, lastReason }),
    ]);
  });

  it('refuses an attempt that has not started', () => {
    refuses(
      [ordered, chosen(), scheduled('plan')],
      lose(),
      /attempt plan#1 of batch b1 has not started/,
    );
  });

  it('refuses an attempt that finished', () => {
    refuses(
      [...brewing(), failed('plan', 1), scheduled('plan', 2)],
      lose(),
      /attempt plan#1 of batch b1 is not running/,
    );
  });

  it('refuses an attempt that was never scheduled', () => {
    refuses(brewing(), lose('plan', 3), /attempt plan#3 of batch b1 is not running/);
  });

  for (const [lane, events] of otherLanes('brewing')) {
    it(`refuses a batch that is ${lane}`, () => {
      refuses(events, lose(), new RegExp(`batch b1 is ${lane}; lose needs it brewing`));
    });
  }
});

describe('decide stall: brewing → Stuck (ADR 0027)', () => {
  const stall: Command = {
    kind: 'stall',
    batchId: 'b1',
    stepId: 'plan',
    attempt: 1,
    lastProgressAt: new Date('2026-10-15T11:40:00.000Z'),
    turnsWithoutProgress: 60,
  };

  it('makes the batch Stuck, saying when the attempt last made progress', () => {
    accepts(brewing(), stall, [
      stuckOn({
        kind: 'stalled',
        stepId: 'plan',
        lastProgressAt: '2026-10-15T11:40:00.000Z',
        turnsWithoutProgress: 60,
      }),
    ]);
  });

  it('refuses an attempt that has not started', () => {
    refuses(
      [ordered, chosen(), scheduled('plan')],
      stall,
      /attempt plan#1 of batch b1 has not started/,
    );
  });

  it('refuses an attempt that finished', () => {
    refuses(
      [...brewing(), failed('plan', 1), scheduled('plan', 2)],
      stall,
      /attempt plan#1 of batch b1 is not running/,
    );
  });

  for (const [lane, events] of otherLanes('brewing')) {
    it(`refuses a batch that is ${lane}`, () => {
      refuses(events, stall, new RegExp(`batch b1 is ${lane}; stall needs it brewing`));
    });
  }
});

describe('decide wait: ordered → Conditioning', () => {
  const wait = (on: WaitCondition): Command => ({ kind: 'wait', batchId: 'b1', on });
  const waiting = (on: WaitCondition): Event => ({
    type: 'batch.waiting',
    batchId: 'b1',
    on,
    remindAt: inTwoDays,
  });
  const release: WaitCondition = {
    kind: 'release',
    repo: 'acme/lib-core',
    package: 'lib-core',
    minVersion: '2.4.0',
  };

  it('waits with a reminder', () => {
    accepts(lanes.ordered, wait(release), [waiting(release)]);
  });

  it('waits for something else while Conditioning', () => {
    accepts(lanes.conditioning, wait(release), [waiting(release)]);
  });

  it('waits for a sibling batch', () => {
    const sibling: WaitCondition = { kind: 'sibling', batchId: 'b2' };
    accepts(
      [
        ordered,
        {
          type: 'batch.ordered',
          batchId: 'b2',
          order: { issue: 200 },
          routeBy: '2026-12-31T00:00:00.000Z',
        },
      ],
      wait(sibling),
      [waiting(sibling)],
    );
  });

  it('refuses a sibling batch that was never ordered', () => {
    refuses(
      lanes.ordered,
      wait({ kind: 'sibling', batchId: 'b2' }),
      /sibling batch b2 was never ordered/,
    );
  });

  it('refuses to wait for itself', () => {
    refuses(
      lanes.ordered,
      wait({ kind: 'sibling', batchId: 'b1' }),
      /batch b1 cannot wait for itself/,
    );
  });

  for (const [lane, events] of otherLanes('ordered', 'conditioning')) {
    it(`refuses a batch that is ${lane}`, () => {
      refuses(
        events,
        wait(release),
        new RegExp(`batch b1 is ${lane}; wait needs it ordered or conditioning`),
      );
    });
  }
});

describe('decide remind (ADR 0025)', () => {
  const remind: Command = { kind: 'remind', batchId: 'b1' };

  it('sets the next reminder of a Conditioning batch', () => {
    accepts(lanes.conditioning, remind, [
      { type: 'batch.waiting', batchId: 'b1', on: merge, remindAt: inTwoDays },
    ]);
  });

  it('sets the next reminder of a Stuck batch, keeping its reason and options', () => {
    const events = [
      ...brewing(),
      { ...stuckEvent(needsInput, ['answer', 'cancel']), remindAt: '2026-10-15T11:00:00.000Z' },
    ];
    accepts(events, remind, [stuckOn(needsInput, ['answer', 'cancel'])]);
  });

  it('sets the next reminder when the current one is due now', () => {
    const waiting: Event = {
      type: 'batch.waiting',
      batchId: 'b1',
      on: merge,
      remindAt: now.toISOString(),
    };
    accepts([ordered, waiting], remind, [{ ...waiting, remindAt: inTwoDays }]);
  });

  it('refuses a Conditioning reminder that is not due', () => {
    const waiting: Event = { type: 'batch.waiting', batchId: 'b1', on: merge, remindAt: inAnHour };
    refuses(
      [ordered, waiting],
      remind,
      /the reminder of batch b1 is not due until 2026-10-15T13:00:00.000Z/,
    );
  });

  it('refuses a reminder that is not due', () => {
    refuses(
      lanes.stuck,
      remind,
      /the reminder of batch b1 is not due until 2026-10-16T12:00:00.000Z/,
    );
  });

  for (const [lane, events] of otherLanes('conditioning', 'stuck')) {
    it(`refuses a batch that is ${lane}`, () => {
      refuses(
        events,
        remind,
        new RegExp(`batch b1 is ${lane}; remind needs it conditioning or stuck`),
      );
    });
  }
});

describe('decide retry: Stuck → brewing', () => {
  const retry: Command = { kind: 'retry', batchId: 'b1', ...by };

  it('schedules the next attempt of the step that made the batch Stuck', () => {
    accepts(lanes.stuck, retry, [
      { type: 'batch.resumed', batchId: 'b1', ...by, action: 'retry' },
      next('plan', 2),
    ]);
  });

  it('refuses when the Stuck batch does not offer it', () => {
    refuses(stuck(needsInput, ['answer', 'cancel']), retry, /batch b1 does not offer retry/);
  });

  for (const [lane, events] of otherLanes('stuck')) {
    it(`refuses a batch that is ${lane}`, () => {
      refuses(events, retry, new RegExp(`batch b1 is ${lane}; retry needs it stuck`));
    });
  }
});

describe('decide skip: Stuck → brewing or on tap', () => {
  const skip: Command = { kind: 'skip', batchId: 'b1', ...by };
  const resumed: Event = { type: 'batch.resumed', batchId: 'b1', ...by, action: 'skip' };

  it('schedules the step after the one that made the batch Stuck', () => {
    accepts(lanes.stuck, skip, [resumed, next('implement')]);
  });

  it('puts the batch on tap when it skips the last step', () => {
    const events = [...brewing('patch', 1, 'nip'), stuckEvent({ ...needsInput, stepId: 'patch' })];
    accepts(events, skip, [
      resumed,
      { type: 'batch.on_tap', batchId: 'b1', pullRequests: [pullRequest] },
    ]);
  });

  it('refuses when the Stuck batch does not offer it', () => {
    refuses(stuck(needsInput, ['answer', 'cancel']), skip, /batch b1 does not offer skip/);
  });

  for (const [lane, events] of otherLanes('stuck')) {
    it(`refuses a batch that is ${lane}`, () => {
      refuses(events, skip, new RegExp(`batch b1 is ${lane}; skip needs it stuck`));
    });
  }
});

describe('decide retry and answer: the step a human names, never skipped (ADR 0064)', () => {
  // The same recipe, but one whose plan step would be skipped if the batch reached it.
  const skipping: Context = {
    ...context,
    recipes: fakeRecipes({
      pint: fakeRecipe({
        steps: ['plan', 'implement', 'green'],
        skips: { plan: 'recipe.testFirst' },
      }),
    }),
  };
  const answers = [{ q: question.q, answer: 'keep' }];
  for (const command of [
    { kind: 'retry', batchId: 'b1', ...by },
    { kind: 'answer', batchId: 'b1', answers, ...by },
  ] as const satisfies readonly Command[]) {
    it(`schedules the step on ${command.kind}, without asking its when`, () => {
      const decision = decide(fold(stuck()), command, skipping);
      assert.deepStrictEqual(decision, decide(fold(stuck()), command, context));
      assert.ok(decision.kind === 'accepted');
      assert.deepStrictEqual(decision.events.at(-1), next('plan', 2));
    });
  }

  it('makes the batch Stuck on a divergence when a failed check routes back to a skipped step', () => {
    const skippedImplement: Event[] = [
      ordered,
      chosen(),
      scheduled('plan'),
      started('plan'),
      {
        type: 'step.finished',
        batchId: 'b1',
        stepId: 'plan',
        attempt: 1,
        outcome: { kind: 'succeeded', output: null },
      },
      { type: 'step.skipped', batchId: 'b1', stepId: 'implement', when: 'recipe.testFirst' },
      scheduled('green'),
      started('green'),
    ];
    const outcome = { kind: 'failed', retryable: false, reason: 'tests fail' } as const;
    const finish: Command = {
      kind: 'finish',
      batchId: 'b1',
      stepId: 'green',
      attempt: 1,
      ending: outcome,
    };
    assert.deepStrictEqual(decide(fold(skippedImplement), finish, context), {
      kind: 'accepted',
      events: [
        { type: 'step.finished', batchId: 'b1', stepId: 'green', attempt: 1, outcome },
        stuckOn({
          kind: 'blocked',
          stepId: 'green',
          blockerKind: 'divergence',
          summary: 'step green routes back to step implement, which was skipped',
        }),
      ],
    });
  });

  it('refuses a rewind to a step the batch skipped: it never ran', () => {
    const skipped: Event[] = [
      ordered,
      chosen(),
      { type: 'step.skipped', batchId: 'b1', stepId: 'gauge', when: 'recipe.testFirst' },
      scheduled('plan'),
      started('plan'),
      stuckEvent(needsInput),
    ];
    const rewind: Command = {
      kind: 'rewind',
      batchId: 'b1',
      toStepId: 'gauge',
      shas: { 'acme/api': sha },
      ...by,
    };
    const withGauge: Context = {
      ...context,
      recipes: fakeRecipes({ pint: fakeRecipe({ steps: ['gauge', 'plan'] }) }),
    };
    assert.deepStrictEqual(decide(fold(skipped), rewind, withGauge), {
      kind: 'refused',
      reason: 'step gauge of batch b1 was never scheduled',
    });
  });
});

describe('decide answer: Stuck → brewing', () => {
  const answer = (answers: { q: string; answer: string }[]): Command => ({
    kind: 'answer',
    batchId: 'b1',
    ...by,
    answers,
  });
  const keep = [{ q: question.q, answer: 'keep' }];

  it('records the answers and schedules the next attempt of the step that asked', () => {
    accepts(lanes.stuck, answer(keep), [
      { type: 'input.received', batchId: 'b1', stepId: 'plan', ...by, answers: keep },
      { type: 'batch.resumed', batchId: 'b1', ...by, action: 'answer' },
      next('plan', 2),
    ]);
  });

  it('refuses a question left unanswered', () => {
    const two = { ...needsInput, questions: [question, { ...question, q: 'Which version?' }] };
    refuses(stuck(two), answer(keep), /question "Which version\?" has no answer/);
  });

  it('refuses an answer to a question nobody asked', () => {
    refuses(
      lanes.stuck,
      answer([...keep, { q: 'Why?', answer: 'Because' }]),
      /no question "Why\?" was asked/,
    );
  });

  it('refuses two answers to one question', () => {
    refuses(
      lanes.stuck,
      answer([...keep, ...keep]),
      /question "Keep the v1 endpoint\?" has two answers/,
    );
  });

  it('refuses a Stuck batch that is not waiting for answers', () => {
    const exhausted: StuckReason = {
      kind: 'attempts_exhausted',
      stepId: 'plan',
      attempts: 2,
      lastReason: 'x',
    };
    refuses(stuck(exhausted), answer(keep), /batch b1 is not waiting for answers/);
  });

  for (const [lane, events] of otherLanes('stuck')) {
    it(`refuses a batch that is ${lane}`, () => {
      refuses(events, answer(keep), new RegExp(`batch b1 is ${lane}; answer needs it stuck`));
    });
  }
});

describe('decide recipe: a human chooses the recipe', () => {
  const recipe: Command = {
    kind: 'recipe',
    batchId: 'b1',
    ...by,
    recipe: 'nip',
    reason: 'one file',
  };
  const chosenByHuman: Event = {
    type: 'batch.recipe_chosen',
    batchId: 'b1',
    recipe: 'nip',
    reason: 'one file',
    source: 'human',
    by: 'octocat',
    via: 'comment',
  };

  it('routes an ordered batch', () => {
    accepts(lanes.ordered, recipe, [chosenByHuman, next('patch')]);
  });

  it('ends Conditioning', () => {
    accepts(lanes.conditioning, recipe, [chosenByHuman, next('patch')]);
  });

  it('re-routes a Stuck batch from the first step of the new recipe', () => {
    accepts(lanes.stuck, recipe, [
      chosenByHuman,
      { type: 'batch.resumed', batchId: 'b1', ...by, action: 'recipe' },
      next('patch'),
    ]);
  });

  it('continues the attempts of a step the new recipe shares', () => {
    accepts(lanes.stuck, { ...recipe, recipe: 'pint' }, [
      { ...chosenByHuman, recipe: 'pint' },
      { type: 'batch.resumed', batchId: 'b1', ...by, action: 'recipe' },
      next('plan', 2),
    ]);
  });

  it('refuses a recipe the Brewery does not have', () => {
    refuses(lanes.stuck, { ...recipe, recipe: 'stout' }, /the Brewery has no recipe stout/);
  });

  it('refuses when the Stuck batch does not offer it', () => {
    refuses(stuck(needsInput, ['answer', 'cancel']), recipe, /batch b1 does not offer recipe/);
  });

  for (const [lane, events] of otherLanes('ordered', 'conditioning', 'stuck')) {
    it(`refuses a batch that is ${lane}`, () => {
      refuses(
        events,
        recipe,
        new RegExp(`batch b1 is ${lane}; recipe needs it ordered, conditioning or stuck`),
      );
    });
  }
});

describe('decide rewind: only from Stuck (ADR 0025)', () => {
  const rewind = (
    shas: Record<string, string> = { 'acme/api': sha },
    toStepId = 'plan',
  ): Command => ({
    kind: 'rewind',
    batchId: 'b1',
    ...by,
    toStepId,
    shas,
  });

  it('records the commit of each repository and schedules the step it goes back to', () => {
    const events = [
      ...brewing(),
      { ...failed('plan', 1), outcome: { kind: 'succeeded', output: null } } as Event,
      next('implement'),
      started('implement'),
      stuckEvent({ ...needsInput, stepId: 'implement' }),
    ];
    accepts(events, rewind(), [
      {
        type: 'batch.rewound',
        batchId: 'b1',
        toStepId: 'plan',
        ...by,
        shas: { 'acme/api': sha },
      },
      next('plan', 2),
    ]);
  });

  it('refuses a rewind without commits', () => {
    refuses(lanes.stuck, rewind({}), /rewind needs the commit of each repository/);
  });

  it('refuses a step the current recipe does not have', () => {
    const rerouted: Event[] = [
      ...stuck(),
      chosen('nip'),
      { type: 'batch.resumed', batchId: 'b1', ...by, action: 'recipe' },
      scheduled('patch'),
      started('patch'),
      stuckEvent({ ...needsInput, stepId: 'patch' }),
    ];
    refuses(rerouted, rewind(), /recipe nip has no step plan/);
  });

  it('refuses a step the batch never ran', () => {
    refuses(lanes.stuck, rewind(undefined, 'green'), /step green of batch b1 was never scheduled/);
  });

  describe('of a sub-order', () => {
    const subOrder: Event[] = [
      {
        type: 'batch.ordered',
        batchId: 'b0',
        order: { issue: 100 },
        routeBy: '2026-12-31T00:00:00.000Z',
      },
      {
        type: 'order.decomposed',
        batchId: 'b0',
        subOrders: [{ issue: 101, repo: 'acme/api' }],
        dependencies: [],
      },
      {
        type: 'batch.ordered',
        batchId: 'b1',
        order: { issue: 101 },
        routeBy: '2026-12-31T00:00:00.000Z',
        parentBatchId: 'b0',
      },
      ...stuck().slice(1),
    ];

    it('records the commit of its repository', () => {
      const decision = decide(fold(subOrder), rewind(), context);
      assert.equal(decision.kind, 'accepted', JSON.stringify(decision));
    });

    it('refuses commits of other repositories', () => {
      refuses(
        subOrder,
        rewind({ 'acme/api': sha, 'acme/web': sha }),
        /sub-order 101 writes only in acme\/api/,
      );
      refuses(subOrder, rewind({ 'acme/web': sha }), /sub-order 101 writes only in acme\/api/);
    });
  });

  it('refuses when the Stuck batch does not offer it', () => {
    refuses(stuck(needsInput, ['answer', 'cancel']), rewind(), /batch b1 does not offer rewind/);
  });

  for (const [lane, events] of otherLanes('stuck')) {
    it(`refuses a batch that is ${lane}`, () => {
      refuses(events, rewind(), new RegExp(`batch b1 is ${lane}; rewind needs it stuck`));
    });
  }
});

describe('decide records who issued a human command and from where (ADR 0019)', () => {
  const from = { by: 'hubot', via: 'dashboard' } as const;
  const issuers = (events: readonly Event[]) =>
    events.flatMap((event) => ('via' in event ? [[event.type, event.by, event.via]] : []));

  for (const [name, events] of [
    ['an ordered', lanes.ordered],
    ['a Conditioning', lanes.conditioning],
  ] as const) {
    it(`by name on the recipe choice of ${name} batch`, () => {
      const decision = decide(
        fold(events),
        { kind: 'recipe', batchId: 'b1', ...from, recipe: 'nip', reason: 'x' },
        context,
      );
      assert.deepStrictEqual(decision.kind === 'accepted' && issuers(decision.events), [
        ['batch.recipe_chosen', 'hubot', 'dashboard'],
      ]);
    });
  }

  it('on a rewind', () => {
    const decision = decide(
      fold(lanes.stuck),
      { kind: 'rewind', batchId: 'b1', ...from, toStepId: 'plan', shas: { 'acme/api': sha } },
      context,
    );
    assert.deepStrictEqual(decision.kind === 'accepted' && issuers(decision.events), [
      ['batch.rewound', 'hubot', 'dashboard'],
    ]);
  });

  it('on a cancel', () => {
    const decision = decide(
      fold(lanes.brewing),
      { kind: 'cancel', batchId: 'b1', ...from },
      context,
    );
    assert.deepStrictEqual(decision.kind === 'accepted' && issuers(decision.events), [
      ['batch.cancelled', 'hubot', 'dashboard'],
    ]);
  });
});

describe('decide cancel', () => {
  const cancel: Command = { kind: 'cancel', batchId: 'b1', ...by };

  for (const lane of ['ordered', 'brewing', 'conditioning', 'stuck'] as const) {
    it(`cancels a batch that is ${lane}`, () => {
      accepts(lanes[lane], cancel, [{ type: 'batch.cancelled', batchId: 'b1', ...by }]);
    });
  }

  it('cancels a Stuck batch that does not list cancel', () => {
    accepts(stuck(needsInput, ['answer']), cancel, [
      { type: 'batch.cancelled', batchId: 'b1', ...by },
    ]);
  });

  for (const [lane, events] of otherLanes('ordered', 'brewing', 'conditioning', 'stuck')) {
    it(`refuses a batch that is ${lane}`, () => {
      refuses(
        events,
        cancel,
        new RegExp(`batch b1 is ${lane}; cancel needs it ordered, brewing, conditioning or stuck`),
      );
    });
  }
});

describe('decide order_again: a person orders an issue again (ADR 0105)', () => {
  const from = { by: 'ada', via: 'terminal' } as const;
  const again = (batchId: string, order: OrderRef): Command => ({
    kind: 'order_again',
    batchId,
    ...from,
    order,
  });
  const orderedAgain = (batchId: string, order: OrderRef): Event => ({
    type: 'batch.ordered',
    batchId,
    order,
    routeBy: inAnHour,
    ...from,
  });

  describe('a Brewery issue', () => {
    it('orders it again once its batch was cancelled, recorded with who and from where', () => {
      accepts(lanes.cancelled, again('b2', { issue: 100 }), [orderedAgain('b2', { issue: 100 })]);
    });

    it('orders it again once its batch is on tap', () => {
      accepts(lanes.on_tap, again('b2', { issue: 100 }), [orderedAgain('b2', { issue: 100 })]);
    });

    it('orders an issue that never had a batch', () => {
      accepts([], again('b1', { issue: 100 }), [orderedAgain('b1', { issue: 100 })]);
    });

    for (const lane of ['ordered', 'brewing', 'conditioning', 'stuck'] as const) {
      it(`refuses it while its batch is ${lane}`, () => {
        refuses(
          lanes[lane],
          again('b2', { issue: 100 }),
          new RegExp(`^batch b1 of #100 is still ${lane}$`),
        );
      });
    }

    it('looks only at the batches of that issue', () => {
      accepts(lanes.brewing, again('b2', { issue: 101 }), [orderedAgain('b2', { issue: 101 })]);
    });

    it('refuses a sub-order: its decomposition orders it', () => {
      const decomposed: Event = {
        type: 'order.decomposed',
        batchId: 'b1',
        subOrders: [{ issue: 101, repo: 'acme/api' }],
        dependencies: [],
      };
      refuses(
        [ordered, decomposed],
        again('b2', { issue: 101 }),
        /^issue #101 is a sub-order of #100; its decomposition orders it$/,
      );
    });

    it('refuses a batch id the log has', () => {
      refuses(lanes.cancelled, again('b1', { issue: 100 }), /batch b1 was already ordered/);
    });
  });

  describe('a target-repository issue', () => {
    const web = { issue: 7, repo: 'acme/web' } as const;
    const webOrdered: Event = {
      type: 'batch.ordered',
      batchId: 'web-7',
      order: web,
      routeBy: inAnHour,
    };
    const webCancelled: Event[] = [
      webOrdered,
      { type: 'batch.cancelled', batchId: 'web-7', by: 'octocat', via: 'plugin' },
    ];
    const applied = (...effects: string[]): Event[] =>
      effects.map((effect) => ({
        type: 'effect.applied',
        key: effectKey.encode({ batchId: 'web-7', effect }),
        result: null,
      }));
    const released = applied('release.label', 'release.comment', 'release.ref');

    it('orders it again once its batch was cancelled and its claim released', () => {
      accepts([...webCancelled, ...released], again('web-7-2', web), [
        orderedAgain('web-7-2', web),
      ]);
    });

    it('compares its repository ignoring case', () => {
      refuses(
        [webOrdered],
        again('web-7-2', { issue: 7, repo: 'Acme/Web' }),
        /^batch web-7 of acme\/web#7 is still ordered$/,
      );
    });

    it('refuses it while its batch is live', () => {
      refuses([webOrdered], again('web-7-2', web), /^batch web-7 of acme\/web#7 is still ordered$/);
    });

    it("refuses the intake's order of it the same way, so a terminal and serve never order it twice", () => {
      refuses(
        [webOrdered],
        { kind: 'order', batchId: 'web-7-2', order: web },
        /^batch web-7 of acme\/web#7 is still ordered$/,
      );
    });

    it('refuses it while the release of its claim is still due', () => {
      for (const events of [
        webCancelled,
        [...webCancelled, ...applied('release.label', 'release.comment')],
      ]) {
        refuses(
          events,
          again('web-7-2', web),
          /^the release of the claim of batch web-7 is still due: foedrum serve applies it, then order acme\/web#7 again$/,
        );
      }
    });

    it('refuses it while a pull request of its batch on tap has no recorded end', () => {
      const onTapEvents: Event[] = [
        webOrdered,
        {
          type: 'batch.recipe_chosen',
          batchId: 'web-7',
          recipe: 'nip',
          reason: 'r',
          source: 'label',
        },
        {
          type: 'step.scheduled',
          batchId: 'web-7',
          stepId: 'patch',
          attempt: 1,
          deadlineAt: inAnHour,
        },
        { type: 'step.started', batchId: 'web-7', stepId: 'patch', attempt: 1 },
        {
          type: 'step.finished',
          batchId: 'web-7',
          stepId: 'patch',
          attempt: 1,
          outcome: { kind: 'succeeded', output: null },
        },
        { type: 'batch.on_tap', batchId: 'web-7', pullRequests: [pullRequest] },
      ];
      refuses(
        onTapEvents,
        again('web-7-2', web),
        /^batch web-7 of acme\/web#7 holds its claim until its pull requests end$/,
      );
      accepts(
        [
          ...onTapEvents,
          { type: 'pull_request.ended', batchId: 'web-7', pullRequest, state: 'closed' },
          ...released,
        ],
        again('web-7-2', web),
        [orderedAgain('web-7-2', web)],
      );
    });

    it('never counts a Brewery issue of the same number', () => {
      accepts([{ ...ordered, order: { issue: 7 } }], again('web-7', web), [
        orderedAgain('web-7', web),
      ]);
    });
  });
});

describe('decide: a step its recipe file no longer has (review of #151)', () => {
  // The step was renamed in the file under the running batch: the real Recipe has no "plan".
  const loaded = loadRecipes({
    recipes: [{ path: 'recipes/pint.jsonc', text: recipeText('pint', [{ brewer: 'malt' }]) }],
    brewers: [{ path: 'brewers/malt.md', text: brewerText('malt') }],
  });
  assert.ok(loaded.valid);
  const renamed: Context = { ...context, recipes: loaded.recipes };
  const diverged = stuckOn({
    kind: 'blocked',
    stepId: 'plan',
    blockerKind: 'divergence',
    summary: 'recipe pint has no step plan any more: its file changed under the batch',
  });
  const finished = (outcome: StepOutcome): Event => ({
    type: 'step.finished',
    batchId: 'b1',
    stepId: 'plan',
    attempt: 1,
    outcome,
  });
  const decided = (command: Command) => decide(fold(brewing()), command, renamed);

  for (const outcome of [
    { kind: 'succeeded', output: null },
    { kind: 'failed', retryable: true, reason: 'tests fail' },
    { kind: 'cancelled' },
  ] as const satisfies readonly StepOutcome[]) {
    it(`records a ${outcome.kind} attempt and makes the batch Stuck on the divergence`, () => {
      const finish = { kind: 'finish', batchId: 'b1', stepId: 'plan', attempt: 1 } as const;
      assert.deepStrictEqual(decided({ ...finish, ending: outcome }), {
        kind: 'accepted',
        events: [finished(outcome), diverged],
      });
    });
  }

  for (const kind of ['retry', 'skip'] as const) {
    it(`refuses a ${kind} of the step that left the recipe, naming it`, () => {
      const stuckState = fold([...brewing(), diverged]);
      const decision = decide(stuckState, { kind, batchId: 'b1', ...by }, renamed);
      assert.deepStrictEqual(decision, { kind: 'refused', reason: 'recipe pint has no step plan' });
    });
  }

  it('records a lost attempt and makes the batch Stuck on the divergence', () => {
    const reason = 'the lease of runner-1 expired at 2026-10-15T11:59:00.000Z';
    assert.deepStrictEqual(
      decided({ kind: 'lose', batchId: 'b1', stepId: 'plan', attempt: 1, reason }),
      {
        kind: 'accepted',
        events: [
          finished({ kind: 'failed', retryable: true, reason: `the attempt was lost: ${reason}` }),
          diverged,
        ],
      },
    );
  });
});

describe('decide: the recipe files are done with no pull request (ADR 0053, #148)', () => {
  const loaded = loadRecipes({
    recipes: [
      { path: 'recipes/pint.jsonc', text: recipeText('pint', [{ id: 'plan', brewer: 'malt' }]) },
    ],
    brewers: [{ path: 'brewers/malt.md', text: brewerText('malt') }],
  });
  assert.ok(loaded.valid);

  it('puts the batch on tap with no pull request after the last step', () => {
    const finish = { kind: 'finish', batchId: 'b1', stepId: 'plan', attempt: 1 } as const;
    const succeeded = { kind: 'succeeded', output: null } as const;
    assert.deepStrictEqual(
      decide(
        fold(brewing()),
        { ...finish, ending: succeeded },
        { ...context, recipes: loaded.recipes },
      ),
      {
        kind: 'accepted',
        events: [
          { type: 'step.finished', batchId: 'b1', stepId: 'plan', attempt: 1, outcome: succeeded },
          { type: 'batch.on_tap', batchId: 'b1', pullRequests: [] },
        ],
      },
    );
  });
});

describe('decide: an onBlocked route of a recipe file (ADR 0064)', () => {
  // Loaded in each test, so a recipe that does not load fails the test, not the suite.
  const withRoute = (when?: string): Context => {
    const loaded = loadRecipes({
      recipes: [
        {
          path: 'recipes/pale.jsonc',
          text: recipeText(
            'pale',
            [
              { id: 'gauge', brewer: 'malt', ...(when === undefined ? {} : { when }) },
              {
                id: 'implement',
                brewer: 'malt',
                onBlocked: { findings: { goto: 'gauge', maxRounds: 1 } },
              },
            ],
            { testFirst: false },
          ),
        },
      ],
      brewers: [{ path: 'brewers/malt.md', text: brewerText('malt') }],
    });
    assert.ok(loaded.valid, loaded.valid ? '' : loaded.problems.join('; '));
    return { ...context, recipes: loaded.recipes };
  };
  const routed: Event = {
    type: 'batch.recipe_chosen',
    batchId: 'b1',
    recipe: 'pale',
    reason: 'small',
    source: 'router',
  };
  const succeeded = { kind: 'succeeded', output: null } as const;
  const done = (stepId: string, attempt = 1): Event[] => [
    scheduled(stepId, attempt),
    started(stepId, attempt),
    { type: 'step.finished', batchId: 'b1', stepId, attempt, outcome: succeeded },
  ];
  const blocked = {
    kind: 'blocked',
    blockerKind: 'findings',
    summary: 'the test is wrong',
  } as const;
  const finish = (attempt: number): Command => ({
    kind: 'finish',
    batchId: 'b1',
    stepId: 'implement',
    attempt,
    ending: blocked,
  });
  const recorded = (attempt: number): Event => ({
    type: 'step.finished',
    batchId: 'b1',
    stepId: 'implement',
    attempt,
    outcome: { kind: 'failed', retryable: false, reason: 'blocked (findings): the test is wrong' },
  });
  const findings = { from: 'implement', why: 'findings' } as const;
  const inHalfAnHour = '2026-10-15T12:30:00.000Z';

  it('goes back along the route, recording it on the schedule, then is Stuck on the findings', () => {
    const firstRound = [
      ordered,
      routed,
      ...done('gauge'),
      scheduled('implement'),
      started('implement'),
    ];
    assert.deepStrictEqual(decide(fold(firstRound), finish(1), withRoute()), {
      kind: 'accepted',
      events: [recorded(1), { ...scheduled('gauge', 2, inHalfAnHour), route: findings }],
    });
    const secondRound: Event[] = [
      ...firstRound,
      recorded(1),
      { ...scheduled('gauge', 2), route: findings },
      started('gauge', 2),
      { type: 'step.finished', batchId: 'b1', stepId: 'gauge', attempt: 2, outcome: succeeded },
      scheduled('implement', 2),
      started('implement', 2),
    ];
    assert.deepStrictEqual(decide(fold(secondRound), finish(2), withRoute()), {
      kind: 'accepted',
      events: [
        recorded(2),
        stuckOn({
          kind: 'blocked',
          stepId: 'implement',
          blockerKind: 'findings',
          summary: 'the test is wrong',
        }),
      ],
    });
  });

  it('makes the batch Stuck on a divergence when the route goes back to a skipped step', () => {
    const skippedGauge: Event[] = [
      ordered,
      routed,
      {
        type: 'step.skipped',
        batchId: 'b1',
        stepId: 'gauge',
        when: 'recipe.testFirst',
      },
      scheduled('implement'),
      started('implement'),
    ];
    assert.deepStrictEqual(decide(fold(skippedGauge), finish(1), withRoute('recipe.testFirst')), {
      kind: 'accepted',
      events: [
        recorded(1),
        stuckOn({
          kind: 'blocked',
          stepId: 'implement',
          blockerKind: 'divergence',
          summary: 'step implement routes back to step gauge, which was skipped',
        }),
      ],
    });
  });
});

describe('decide: a when that is false skips its step (ADR 0064)', () => {
  // The pale recipe commits nothing, so testFirst resolves off: gauge and tidy are skipped.
  // Loaded in each test, so a recipe that does not load fails the test, not the suite.
  const pale = (): Context => {
    const loaded = loadRecipes({
      recipes: [
        {
          path: 'recipes/pale.jsonc',
          text: recipeText('pale', [
            { id: 'gauge', brewer: 'malt', when: 'recipe.testFirst' },
            { id: 'plan', brewer: 'malt' },
            { id: 'tidy', brewer: 'malt', when: 'recipe.testFirst' },
          ]),
        },
        {
          path: 'recipes/mild.jsonc',
          text: recipeText('mild', [{ id: 'gauge', brewer: 'malt', when: 'recipe.testFirst' }]),
        },
      ],
      brewers: [{ path: 'brewers/malt.md', text: brewerText('malt') }],
    });
    assert.ok(loaded.valid, loaded.valid ? '' : loaded.problems.join('\n'));
    return { ...context, recipes: loaded.recipes };
  };
  const decided = (events: Event[], command: Command) => decide(fold(events), command, pale());
  const skipped = (stepId: string): Event => ({
    type: 'step.skipped',
    batchId: 'b1',
    stepId,
    when: 'recipe.testFirst',
  });
  const inHalfAnHour = '2026-10-15T12:30:00.000Z';
  const planNext = scheduled('plan', 1, inHalfAnHour);
  const routed = (recipe: string): Event => ({
    type: 'batch.recipe_chosen',
    batchId: 'b1',
    recipe,
    reason: 'small',
    source: 'router',
  });
  const route = (recipe: string): Command => ({
    kind: 'route',
    batchId: 'b1',
    recipe,
    reason: 'small',
    source: 'router',
  });
  const atPlan = [ordered, routed('pale'), skipped('gauge'), scheduled('plan'), started('plan')];
  const succeeded = { kind: 'succeeded', output: null } as const;

  it('records the skipped first step and schedules the next one', () => {
    assert.deepStrictEqual(decided([ordered], route('pale')), {
      kind: 'accepted',
      events: [routed('pale'), skipped('gauge'), planNext],
    });
  });

  it('skips the step after one that succeeded, and is done after the last', () => {
    const finish = { kind: 'finish', batchId: 'b1', stepId: 'plan', attempt: 1 } as const;
    assert.deepStrictEqual(decided(atPlan, { ...finish, ending: succeeded }), {
      kind: 'accepted',
      events: [
        { type: 'step.finished', batchId: 'b1', stepId: 'plan', attempt: 1, outcome: succeeded },
        skipped('tidy'),
        { type: 'batch.on_tap', batchId: 'b1', pullRequests: [] },
      ],
    });
  });

  it('puts a batch whose every step is skipped on tap', () => {
    assert.deepStrictEqual(decided([ordered], route('mild')), {
      kind: 'accepted',
      events: [
        routed('mild'),
        skipped('gauge'),
        { type: 'batch.on_tap', batchId: 'b1', pullRequests: [] },
      ],
    });
  });

  it("skips the step after one a human skipped, and the first step of a human's recipe", () => {
    const stuckPlan = [
      ...atPlan,
      stuckEvent({ kind: 'waiting_for_session', stepId: 'plan' }, withoutAnswer),
    ];
    assert.deepStrictEqual(decided(stuckPlan, { kind: 'skip', batchId: 'b1', ...by }), {
      kind: 'accepted',
      events: [
        { type: 'batch.resumed', batchId: 'b1', ...by, action: 'skip' },
        skipped('tidy'),
        { type: 'batch.on_tap', batchId: 'b1', pullRequests: [] },
      ],
    });
    const recipe: Command = {
      kind: 'recipe',
      batchId: 'b1',
      recipe: 'pale',
      reason: 'again',
      ...by,
    };
    assert.deepStrictEqual(decided(stuckPlan, recipe), {
      kind: 'accepted',
      events: [
        {
          type: 'batch.recipe_chosen',
          batchId: 'b1',
          recipe: 'pale',
          reason: 'again',
          source: 'human',
          ...by,
        },
        { type: 'batch.resumed', batchId: 'b1', ...by, action: 'recipe' },
        skipped('gauge'),
        scheduled('plan', 2, inHalfAnHour),
      ],
    });
  });
});

describe('decide: on tap with the pull request of the openPullRequest step (ADR 0071)', () => {
  const opened = 'https://github.com/acme/api/pull/12';
  const open = 'open-pull-request';
  const ale = (skips: Record<string, string> = {}) => ({
    ...context,
    recipes: fakeRecipes({
      ale: fakeRecipe({
        steps: ['plan', open],
        actions: { [open]: 'openPullRequest' },
        skips,
        pullRequests: [],
      }),
    }),
  });
  const recorded: Event = {
    type: 'effect.applied',
    key: JSON.stringify(['b1', 'pull_request']),
    result: opened,
  };
  const finish = {
    kind: 'finish',
    batchId: 'b1',
    stepId: open,
    attempt: 1,
    ending: { kind: 'succeeded', output: { pullRequest: opened } },
  } as const;
  const finished: Event = {
    type: 'step.finished',
    batchId: 'b1',
    stepId: open,
    attempt: 1,
    outcome: { kind: 'succeeded', output: { pullRequest: opened } },
  };

  it('goes on tap with the pull request the ledger recorded for the batch', () => {
    assert.deepStrictEqual(decide(fold([...brewing(open, 1, 'ale'), recorded]), finish, ale()), {
      kind: 'accepted',
      events: [finished, { type: 'batch.on_tap', batchId: 'b1', pullRequests: [opened] }],
    });
  });

  it('refuses to go on tap without it', () => {
    assert.deepStrictEqual(decide(fold(brewing(open, 1, 'ale')), finish, ale()), {
      kind: 'refused',
      reason: `batch b1 goes on tap only with the pull request of its step ${open}, and the ledger has none`,
    });
  });

  it('goes on tap without one when its when skipped the step', () => {
    const when = 'recipe.testFirst';
    const done = {
      kind: 'finish',
      batchId: 'b1',
      stepId: 'plan',
      attempt: 1,
      ending: { kind: 'succeeded', output: null },
    } as const;
    assert.deepStrictEqual(decide(fold(brewing('plan', 1, 'ale')), done, ale({ [open]: when })), {
      kind: 'accepted',
      events: [
        {
          type: 'step.finished',
          batchId: 'b1',
          stepId: 'plan',
          attempt: 1,
          outcome: { kind: 'succeeded', output: null },
        },
        { type: 'step.skipped', batchId: 'b1', stepId: open, when },
        { type: 'batch.on_tap', batchId: 'b1', pullRequests: [] },
      ],
    });
  });

  it('refuses a skip of the step, which would put the batch on tap without it', () => {
    const blocked: StuckReason = {
      kind: 'deadline_passed',
      stepId: open,
      deadlineAt: '2026-10-15T11:00:00.000Z',
    };
    const events = [...brewing(open, 1, 'ale'), stuckEvent(blocked, withoutAnswer)];
    assert.deepStrictEqual(decide(fold(events), { kind: 'skip', batchId: 'b1', ...by }, ale()), {
      kind: 'refused',
      reason: `batch b1 goes on tap only with the pull request of its step ${open}, and the ledger has none`,
    });
  });
});
