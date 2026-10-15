import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { type Command, type Context, decide, stuckOptions } from '../../src/engine/decide.ts';
import { fold, type Lane, type State } from '../../src/engine/fold.ts';
import type { Event, StuckOption, StuckReason, WaitCondition } from '../../src/schemas/events.ts';
import type { StepOutcome } from '../../src/schemas/step-outcome.ts';
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

const ordered: Event = { type: 'batch.ordered', batchId: 'b1', order: { issue: 100 } };
const chosen = (recipe = 'pint'): Event => ({
  type: 'batch.recipe_chosen',
  batchId: 'b1',
  recipe,
  reason: 'feature label',
  by: 'label',
});
const scheduled = (
  stepId: string,
  attempt = 1,
  deadlineAt = '2026-10-15T11:00:00.000Z',
): Event => ({
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
const next = (stepId: string, attempt = 1): Event => scheduled(stepId, attempt, inAnHour);

describe('stuckOptions', () => {
  it('offers answer only when the batch waits for answers', () => {
    assert.deepStrictEqual(stuckOptions(needsInput), [...all]);
  });

  const others: StuckReason[] = [
    { kind: 'blocked', stepId: 'plan', blockerKind: 'environment', summary: 'CI is down' },
    { kind: 'attempts_exhausted', stepId: 'plan', attempts: 2, lastReason: 'tests fail' },
    { kind: 'deadline_passed', stepId: 'plan', deadlineAt: inAnHour },
    { kind: 'waiting_for_session', stepId: 'plan' },
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
    accepts([], { kind: 'record', event: ordered }, [ordered]);
  });

  it('refuses an event the lane does not allow', () => {
    refuses(
      lanes.stuck,
      { kind: 'record', event: started('plan', 1) as Extract<Event, { type: 'step.started' }> },
      /batch b1 is stuck; step.started needs it brewing/,
    );
  });

  it('refuses an event the fold would throw on', () => {
    refuses([ordered], { kind: 'record', event: ordered }, /batch b1 was already ordered/);
  });
});

describe('decide route: ordered or conditioning → brewing', () => {
  const route: Command = {
    kind: 'route',
    batchId: 'b1',
    recipe: 'pint',
    reason: 'small',
    by: 'router',
  };
  const routed: Event[] = [
    { type: 'batch.recipe_chosen', batchId: 'b1', recipe: 'pint', reason: 'small', by: 'router' },
    next('plan'),
  ];

  it('chooses the recipe and schedules its first step', () => {
    accepts(lanes.ordered, route, routed);
  });

  it('ends Conditioning', () => {
    accepts(lanes.conditioning, route, routed);
  });

  it('refuses a recipe the book does not have', () => {
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

  it('sends a failed check back along its route', () => {
    accepts(brewing('green'), finish(final, 'green'), [
      finished(final, 'green'),
      next('implement'),
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
      next('implement'),
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
        next('plan'),
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

  it('refuses a recipe the book no longer has', () => {
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
      [ordered, { type: 'batch.ordered', batchId: 'b2', order: { issue: 200 } }],
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
    by: 'human',
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

  it('refuses a recipe the book does not have', () => {
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
      { type: 'batch.ordered', batchId: 'b0', order: { issue: 100 } },
      {
        type: 'order.decomposed',
        batchId: 'b0',
        subOrders: [{ issue: 101, repo: 'acme/api' }],
        dependencies: [],
      },
      { type: 'batch.ordered', batchId: 'b1', order: { issue: 101 }, parentBatchId: 'b0' },
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
