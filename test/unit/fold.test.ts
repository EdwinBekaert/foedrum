import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { type Batch, emptyState, fold, type State } from '../../src/engine/fold.ts';
import type { Event, StuckReason } from '../../src/schemas/events.ts';

const deadlineAt = '2026-10-15T10:00:00.000Z';
const pullRequest = 'https://github.com/acme/api/pull/7';
const session = { id: 's1', worktree: 'work/b1/plan', claudeVersion: '2.1.300' };
const question = {
  q: 'Keep the v1 endpoint?',
  options: ['keep', 'remove'],
  recommended: 'keep',
  whyBlocking: 'Removing it breaks the mobile app',
};
const ordered: Event = { type: 'batch.ordered', batchId: 'b1', order: { issue: 100 } };
const scheduled: Event = {
  type: 'step.scheduled',
  batchId: 'b1',
  stepId: 'plan',
  attempt: 1,
  deadlineAt,
};

const batch = (state: State, id = 'b1'): Batch => {
  const found = state.batches.get(id);
  assert.ok(found, `batch ${id} exists`);
  return found;
};

describe('fold', () => {
  it('starts from the empty state', () => {
    const empty = {
      orders: new Map(),
      subOrders: new Map(),
      batches: new Map(),
      bottles: new Map(),
      releases: [],
      effects: new Map(),
    };
    assert.deepStrictEqual(fold([]), empty);
    assert.deepStrictEqual(emptyState, empty);
  });

  it('orders a batch for an issue', () => {
    const state = fold([ordered]);
    assert.deepStrictEqual(batch(state), {
      id: 'b1',
      issue: 100,
      lane: { kind: 'ordered' },
      steps: new Map(),
      rewinds: [],
    });
    assert.deepStrictEqual(
      state.orders,
      new Map([[100, { issue: 100, batchIds: ['b1'], subOrders: [], dependencies: [] }]]),
    );
  });

  it('keeps every batch of an issue, and the parent batch of a sub-order', () => {
    const state = fold([
      ordered,
      { type: 'batch.ordered', batchId: 'b2', order: { issue: 101 }, parentBatchId: 'b1' },
      { type: 'batch.ordered', batchId: 'b3', order: { issue: 100 } },
    ]);
    assert.equal(batch(state, 'b2').parentBatchId, 'b1');
    assert.deepStrictEqual(state.orders.get(100)?.batchIds, ['b1', 'b3']);
    assert.deepStrictEqual(state.orders.get(101)?.batchIds, ['b2']);
  });

  it('records the chosen recipe, and a later choice replaces it', () => {
    const state = fold([
      ordered,
      { type: 'batch.recipe_chosen', batchId: 'b1', recipe: 'nip', reason: 'small', by: 'router' },
      { type: 'batch.recipe_chosen', batchId: 'b1', recipe: 'pint', reason: 'size', by: 'human' },
    ]);
    assert.deepStrictEqual(batch(state).recipe, { name: 'pint', reason: 'size', by: 'human' });
  });

  it('follows an attempt from scheduled to started to finished, and the batch is brewing', () => {
    const usage = { inputTokens: 10, outputTokens: 5, cacheReadTokens: 2, cacheWriteTokens: 1 };
    const outcome = { kind: 'succeeded', output: { plan: 'ok' } } as const;
    const base = { batchId: 'b1', stepId: 'plan', attempt: 1 };
    const states = [
      fold([ordered, scheduled]),
      fold([ordered, scheduled, { type: 'step.started', ...base, session }]),
      fold([
        ordered,
        scheduled,
        { type: 'step.started', ...base, session },
        { type: 'step.finished', ...base, outcome, usage },
      ]),
    ];
    assert.deepStrictEqual(
      states.map((state) => batch(state).steps.get('plan')?.attempts.get(1)),
      [
        { phase: 'scheduled', attempt: 1, deadlineAt },
        { phase: 'started', attempt: 1, deadlineAt, session },
        { phase: 'finished', attempt: 1, deadlineAt, session, outcome, usage },
      ],
    );
    for (const state of states) assert.deepStrictEqual(batch(state).lane, { kind: 'brewing' });
  });

  it('leaves out a session and usage the events do not carry', () => {
    const base = { batchId: 'b1', stepId: 'plan', attempt: 1 };
    const outcome = { kind: 'cancelled' } as const;
    const state = fold([
      ordered,
      scheduled,
      { type: 'step.started', ...base },
      { type: 'step.finished', ...base, outcome },
    ]);
    assert.deepStrictEqual(batch(state).steps.get('plan')?.attempts.get(1), {
      phase: 'finished',
      attempt: 1,
      deadlineAt,
      outcome,
    });
  });

  it('keeps earlier attempts of a step', () => {
    const state = fold([ordered, scheduled, { ...scheduled, attempt: 2, deadlineAt: 'later' }]);
    assert.deepStrictEqual([...(batch(state).steps.get('plan')?.attempts.keys() ?? [])], [1, 2]);
  });

  it('records the answers a step received', () => {
    const answers = [{ q: question.q, answer: 'keep' }];
    const state = fold([
      ordered,
      scheduled,
      {
        type: 'input.received',
        batchId: 'b1',
        stepId: 'plan',
        by: 'octocat',
        via: 'plugin',
        answers,
      },
    ]);
    assert.deepStrictEqual(batch(state).steps.get('plan')?.inputs, [
      { by: 'octocat', via: 'plugin', answers },
    ]);
  });

  it('moves the batch between lanes as the events say', () => {
    const reason: StuckReason = { kind: 'needs_input', stepId: 'plan', questions: [question] };
    const on = { kind: 'merge', pullRequest } as const;
    const lanes = (events: Event[]) => batch(fold([ordered, scheduled, ...events])).lane;

    const stuck: Event = { type: 'batch.stuck', batchId: 'b1', reason, options: ['answer'] };
    assert.deepStrictEqual(lanes([stuck]), { kind: 'stuck', reason, options: ['answer'] });
    assert.deepStrictEqual(
      lanes([
        stuck,
        { type: 'batch.resumed', batchId: 'b1', by: 'octocat', via: 'comment', action: 'answer' },
      ]),
      { kind: 'brewing' },
    );
    assert.deepStrictEqual(
      lanes([{ type: 'batch.waiting', batchId: 'b1', on, remindAt: deadlineAt }]),
      { kind: 'conditioning', on, remindAt: deadlineAt },
    );
    assert.deepStrictEqual(
      lanes([{ type: 'batch.on_tap', batchId: 'b1', pullRequests: [pullRequest] }]),
      { kind: 'on_tap', pullRequests: [pullRequest] },
    );
    assert.deepStrictEqual(lanes([{ type: 'batch.cancelled', batchId: 'b1', by: 'octocat' }]), {
      kind: 'cancelled',
      by: 'octocat',
    });
  });

  it('records a rewind, and the batch brews again', () => {
    const rewind = { toStepId: 'plan', by: 'octocat', shas: { 'acme/api': 'a'.repeat(40) } };
    const state = fold([
      ordered,
      scheduled,
      {
        type: 'batch.stuck',
        batchId: 'b1',
        reason: { kind: 'waiting_for_session', stepId: 'plan' },
        options: ['rewind'],
      },
      { type: 'batch.rewound', batchId: 'b1', ...rewind },
    ]);
    assert.deepStrictEqual(batch(state).rewinds, [rewind]);
    assert.deepStrictEqual(batch(state).lane, { kind: 'brewing' });
  });

  it('records the breakdown of an order into sub-orders, one repository each', () => {
    const dependencies = [{ subOrder: 102, blockedBy: 101, kind: 'release' }] as const;
    const state = fold([
      ordered,
      {
        type: 'order.decomposed',
        batchId: 'b1',
        subOrders: [
          { issue: 101, repo: 'acme/lib-core' },
          { issue: 102, repo: 'acme/api' },
        ],
        dependencies: [...dependencies],
      },
    ]);
    assert.deepStrictEqual(state.orders.get(100), {
      issue: 100,
      batchIds: ['b1'],
      subOrders: [101, 102],
      dependencies,
    });
    assert.deepStrictEqual(
      state.subOrders,
      new Map([
        [101, { issue: 101, repo: 'acme/lib-core', order: 100, batchIds: [] }],
        [102, { issue: 102, repo: 'acme/api', order: 100, batchIds: [] }],
      ]),
    );
  });

  it('replaces an earlier breakdown of the same order', () => {
    const decomposed = (subOrders: { issue: number; repo: string }[]): Event => ({
      type: 'order.decomposed',
      batchId: 'b1',
      subOrders,
      dependencies: [],
    });
    const state = fold([
      ordered,
      decomposed([
        { issue: 101, repo: 'acme/lib-core' },
        { issue: 102, repo: 'acme/api' },
      ]),
      decomposed([{ issue: 102, repo: 'acme/web' }]),
    ]);
    assert.deepStrictEqual(state.orders.get(100)?.subOrders, [102]);
    assert.deepStrictEqual(
      state.subOrders,
      new Map([[102, { issue: 102, repo: 'acme/web', order: 100, batchIds: [] }]]),
    );
  });

  it('lists the batches of a sub-order on the sub-order, not as an order', () => {
    const state = fold([
      ordered,
      {
        type: 'order.decomposed',
        batchId: 'b1',
        subOrders: [{ issue: 101, repo: 'acme/api' }],
        dependencies: [],
      },
      { type: 'batch.ordered', batchId: 'b2', order: { issue: 101 }, parentBatchId: 'b1' },
    ]);
    assert.deepStrictEqual([...state.orders.keys()], [100]);
    assert.deepStrictEqual(state.subOrders.get(101), {
      issue: 101,
      repo: 'acme/api',
      order: 100,
      batchIds: ['b2'],
    });
  });

  it('keeps the batches of a sub-order that a new breakdown keeps', () => {
    const decomposed = (repo: string): Event => ({
      type: 'order.decomposed',
      batchId: 'b1',
      subOrders: [{ issue: 101, repo }],
      dependencies: [],
    });
    const state = fold([
      ordered,
      decomposed('acme/api'),
      { type: 'batch.ordered', batchId: 'b2', order: { issue: 101 }, parentBatchId: 'b1' },
      decomposed('acme/web'),
    ]);
    assert.deepStrictEqual(state.subOrders.get(101), {
      issue: 101,
      repo: 'acme/web',
      order: 100,
      batchIds: ['b2'],
    });
  });

  it('keeps the sub-orders of other orders when one order is decomposed again', () => {
    const state = fold([
      ordered,
      { type: 'batch.ordered', batchId: 'b2', order: { issue: 200 } },
      {
        type: 'order.decomposed',
        batchId: 'b2',
        subOrders: [{ issue: 201, repo: 'acme/web' }],
        dependencies: [],
      },
      {
        type: 'order.decomposed',
        batchId: 'b1',
        subOrders: [{ issue: 101, repo: 'acme/api' }],
        dependencies: [],
      },
    ]);
    assert.equal(state.subOrders.get(201)?.order, 200);
    assert.deepStrictEqual(state.orders.get(200)?.subOrders, [201]);
  });

  it('replaces the dependencies of an earlier breakdown', () => {
    const subOrders = [
      { issue: 101, repo: 'acme/lib-core' },
      { issue: 102, repo: 'acme/api' },
    ];
    const state = fold([
      ordered,
      {
        type: 'order.decomposed',
        batchId: 'b1',
        subOrders,
        dependencies: [{ subOrder: 102, blockedBy: 101, kind: 'release' }],
      },
      {
        type: 'order.decomposed',
        batchId: 'b1',
        subOrders,
        dependencies: [{ subOrder: 101, blockedBy: 102, kind: 'code' }],
      },
    ]);
    assert.deepStrictEqual(state.orders.get(100)?.dependencies, [
      { subOrder: 101, blockedBy: 102, kind: 'code' },
    ]);
  });

  it('keeps every input, rewind and release in order', () => {
    const input = (answer: string): Event => ({
      type: 'input.received',
      batchId: 'b1',
      stepId: 'plan',
      by: 'octocat',
      via: 'plugin',
      answers: [{ q: question.q, answer }],
    });
    const rewound = (by: string): Event => ({
      type: 'batch.rewound',
      batchId: 'b1',
      toStepId: 'plan',
      by,
      shas: {},
    });
    const release = (version: string): Event => ({
      type: 'release.observed',
      repo: 'acme/lib-core',
      package: 'lib-core',
      version,
    });
    const state = fold([
      ordered,
      scheduled,
      input('keep'),
      { ...scheduled, attempt: 2 },
      input('remove'),
      rewound('octocat'),
      rewound('hubot'),
      release('2.4.0'),
      release('2.5.0'),
    ]);
    const step = batch(state).steps.get('plan');
    assert.deepStrictEqual(
      step?.inputs.map((received) => received.answers[0]?.answer),
      ['keep', 'remove'],
    );
    assert.deepStrictEqual(
      batch(state).rewinds.map((rewind) => rewind.by),
      ['octocat', 'hubot'],
    );
    assert.deepStrictEqual(
      state.releases.map((observed) => observed.version),
      ['2.4.0', '2.5.0'],
    );
  });

  it('records bottles, releases and applied effects', () => {
    const bottle = { bottleId: 'k1', repo: 'acme/api', subOrders: [101, 102], pullRequest };
    const release = { repo: 'acme/lib-core', package: 'lib-core', version: '2.4.0' };
    const state = fold([
      { type: 'bottle.opened', ...bottle },
      { type: 'release.observed', ...release },
      { type: 'effect.applied', key: 'b1:plan:1:pr', result: { number: 7 } },
    ]);
    assert.deepStrictEqual(
      state.bottles,
      new Map([['k1', { id: 'k1', repo: 'acme/api', subOrders: [101, 102], pullRequest }]]),
    );
    assert.deepStrictEqual(state.releases, [release]);
    assert.deepStrictEqual(state.effects, new Map([['b1:plan:1:pr', { number: 7 }]]));
  });

  it('continues from a given state', () => {
    const state = fold([scheduled], fold([ordered]));
    assert.deepStrictEqual(batch(state).lane, { kind: 'brewing' });
  });
});

describe('fold of an inconsistent log', () => {
  const started: Event = { type: 'step.started', batchId: 'b1', stepId: 'plan', attempt: 1 };
  const finished: Event = {
    type: 'step.finished',
    batchId: 'b1',
    stepId: 'plan',
    attempt: 1,
    outcome: { kind: 'cancelled' },
  };
  const cases: [string, Event[], RegExp][] = [
    ['an event for a batch that was never ordered', [scheduled], /batch b1 was never ordered/],
    ['a batch ordered twice', [ordered, ordered], /batch b1 was already ordered/],
    [
      'a parent batch that was never ordered',
      [{ ...ordered, parentBatchId: 'b0' }],
      /batch b0 was never ordered/,
    ],
    ['an attempt started before it was scheduled', [ordered, started], /plan#1 .*never scheduled/],
    [
      'an attempt finished before it was started',
      [ordered, scheduled, finished],
      /plan#1 .*never started/,
    ],
    ['an attempt scheduled twice', [ordered, scheduled, scheduled], /plan#1 .*already scheduled/],
    [
      'an attempt started twice',
      [ordered, scheduled, started, started],
      /plan#1 .*already started/,
    ],
    [
      'an attempt started after it finished',
      [ordered, scheduled, started, finished, started],
      /plan#1 .*already started/,
    ],
    [
      'an attempt finished twice',
      [ordered, scheduled, started, finished, finished],
      /plan#1 .*already finished/,
    ],
    [
      'input for a step that never ran',
      [
        ordered,
        {
          type: 'input.received',
          batchId: 'b1',
          stepId: 'plan',
          by: 'octocat',
          via: 'plugin',
          answers: [{ q: 'Why?', answer: 'Because' }],
        },
      ],
      /step plan of batch b1 was never scheduled/,
    ],
    [
      'a rewind to a step that never ran',
      [
        ordered,
        { type: 'batch.rewound', batchId: 'b1', toStepId: 'plan', by: 'octocat', shas: {} },
      ],
      /step plan of batch b1 was never scheduled/,
    ],
    [
      'a sub-order that already belongs to another order',
      [
        ordered,
        { type: 'batch.ordered', batchId: 'b2', order: { issue: 200 } },
        {
          type: 'order.decomposed',
          batchId: 'b1',
          subOrders: [{ issue: 101, repo: 'acme/api' }],
          dependencies: [],
        },
        {
          type: 'order.decomposed',
          batchId: 'b2',
          subOrders: [{ issue: 101, repo: 'acme/api' }],
          dependencies: [],
        },
      ],
      /sub-order 101 already belongs to order 100/,
    ],
    [
      'a bottle opened twice',
      [
        { type: 'bottle.opened', bottleId: 'k1', repo: 'acme/api', subOrders: [101], pullRequest },
        { type: 'bottle.opened', bottleId: 'k1', repo: 'acme/api', subOrders: [101], pullRequest },
      ],
      /bottle k1 was already opened/,
    ],
    [
      'an effect applied twice',
      [
        { type: 'effect.applied', key: 'b1:plan:1:pr', result: { number: 7 } },
        { type: 'effect.applied', key: 'b1:plan:1:pr', result: { number: 8 } },
      ],
      /effect b1:plan:1:pr was already applied/,
    ],
  ];

  for (const [name, events, message] of cases) {
    it(`throws on ${name}`, () => {
      assert.throws(() => fold(events), message);
    });
  }

  const batchEvents: Event[] = [
    { type: 'batch.recipe_chosen', batchId: 'b1', recipe: 'nip', reason: 'small', by: 'router' },
    scheduled,
    started,
    finished,
    {
      type: 'input.received',
      batchId: 'b1',
      stepId: 'plan',
      by: 'octocat',
      via: 'plugin',
      answers: [{ q: 'Why?', answer: 'Because' }],
    },
    {
      type: 'batch.stuck',
      batchId: 'b1',
      reason: { kind: 'waiting_for_session', stepId: 'plan' },
      options: ['cancel'],
    },
    { type: 'batch.resumed', batchId: 'b1', by: 'octocat', via: 'plugin', action: 'retry' },
    {
      type: 'order.decomposed',
      batchId: 'b1',
      subOrders: [{ issue: 101, repo: 'acme/api' }],
      dependencies: [],
    },
    {
      type: 'batch.waiting',
      batchId: 'b1',
      on: { kind: 'merge', pullRequest },
      remindAt: deadlineAt,
    },
    { type: 'batch.rewound', batchId: 'b1', toStepId: 'plan', by: 'octocat', shas: {} },
    { type: 'batch.on_tap', batchId: 'b1', pullRequests: [pullRequest] },
    { type: 'batch.cancelled', batchId: 'b1', by: 'octocat' },
  ];
  for (const event of batchEvents) {
    it(`throws on ${event.type} for a batch that was never ordered`, () => {
      assert.throws(() => fold([event]), /batch b1 was never ordered/);
    });
  }
});
