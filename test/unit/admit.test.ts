import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { admit } from '../../src/engine/admit.ts';
import { effectKey } from '../../src/engine/effect-key.ts';
import { emptyState, fold, type Lane } from '../../src/engine/fold.ts';
import type { Event } from '../../src/schemas/events.ts';

const deadlineAt = '2026-10-15T10:00:00.000Z';
const remindAt = '2026-10-17T10:00:00.000Z';
const pullRequest = 'https://github.com/acme/api/pull/7';
const question = {
  q: 'Keep the v1 endpoint?',
  options: ['keep', 'remove'],
  recommended: 'keep',
  whyBlocking: 'Removing it breaks the mobile app',
};
const ordered: Event = { type: 'batch.ordered', batchId: 'b1', order: { issue: 100 } };
const chosen: Event = {
  type: 'batch.recipe_chosen',
  batchId: 'b1',
  recipe: 'pint',
  reason: 'feature label',
  source: 'label',
};
const attempt = { batchId: 'b1', stepId: 'plan', attempt: 1 };
const scheduled: Event = { type: 'step.scheduled', ...attempt, deadlineAt };
const started: Event = { type: 'step.started', ...attempt };
const succeeded: Event = {
  type: 'step.finished',
  ...attempt,
  outcome: { kind: 'succeeded', output: null },
};
const stuck: Event = {
  type: 'batch.stuck',
  batchId: 'b1',
  reason: { kind: 'needs_input', stepId: 'plan', questions: [question] },
  options: ['answer', 'retry', 'skip', 'recipe', 'rewind', 'cancel'],
  remindAt,
};
const waiting: Event = {
  type: 'batch.waiting',
  batchId: 'b1',
  on: { kind: 'merge', pullRequest },
  remindAt,
};
const onTap: Event = { type: 'batch.on_tap', batchId: 'b1', pullRequests: [pullRequest] };
const cancelled: Event = { type: 'batch.cancelled', batchId: 'b1', by: 'octocat', via: 'plugin' };
const resumed: Event = {
  type: 'batch.resumed',
  batchId: 'b1',
  by: 'octocat',
  via: 'plugin',
  action: 'retry',
};
const rewound: Event = {
  type: 'batch.rewound',
  batchId: 'b1',
  toStepId: 'plan',
  by: 'octocat',
  via: 'plugin',
  shas: { 'acme/api': 'a'.repeat(40) },
};
const answered: Event = {
  type: 'input.received',
  batchId: 'b1',
  stepId: 'plan',
  by: 'octocat',
  via: 'comment',
  answers: [{ q: question.q, answer: 'keep' }],
};

/** A log that leaves batch b1 in each lane. */
const lanes: Record<Lane['kind'], Event[]> = {
  ordered: [ordered],
  brewing: [ordered, chosen, scheduled, started],
  conditioning: [ordered, waiting],
  stuck: [ordered, chosen, scheduled, started, stuck],
  on_tap: [ordered, chosen, scheduled, started, succeeded, onTap],
  cancelled: [ordered, chosen, scheduled, started, cancelled],
};

const refused = (events: Event[], last: Event, reason: RegExp): void => {
  const decision = admit(fold(events), [last]);
  assert.equal(decision.kind, 'refused');
  assert.match(decision.kind === 'refused' ? decision.reason : '', reason);
};

describe('admit', () => {
  it('accepts events that are valid in order, and returns them', () => {
    const events = [ordered, chosen, scheduled, started, succeeded, onTap];
    assert.deepStrictEqual(admit(emptyState, events), { kind: 'accepted', events });
  });

  it('accepts nothing at all', () => {
    assert.deepStrictEqual(admit(emptyState, []), { kind: 'accepted', events: [] });
  });

  it('refuses all events when one is refused, naming its index and type', () => {
    assert.deepStrictEqual(admit(emptyState, [ordered, chosen, scheduled, scheduled]), {
      kind: 'refused',
      reason: 'event 3 (step.scheduled): attempt plan#1 of batch b1 was already scheduled',
    });
  });

  it('refuses an event its schema rejects', () => {
    const decision = admit(emptyState, [{ ...ordered, batchId: 'B1' }]);
    assert.equal(decision.kind, 'refused');
    assert.match(
      decision.kind === 'refused' ? decision.reason : '',
      /^event 0 \(batch.ordered\): .*batchId/s,
    );
  });
});

describe('admit refuses what the fold throws on', () => {
  const prKey = effectKey.encode({ batchId: 'b1', stepId: 'plan', attempt: 1, effect: 'pr' });
  const decomposed = (batchId: string, issue: number, repo = 'acme/api'): Event => ({
    type: 'order.decomposed',
    batchId,
    subOrders: [{ issue, repo }],
    dependencies: [],
  });
  const bottle: Event = {
    type: 'bottle.opened',
    bottleId: 'k1',
    repo: 'acme/api',
    subOrders: [101],
    pullRequest,
  };
  // Sub-order 101 of acme/api with a batch on tap, so only the fold refuses a second bottle k1.
  const bottled: Event[] = [
    ordered,
    decomposed('b1', 101),
    { type: 'batch.ordered', batchId: 'b2', order: { issue: 101 }, parentBatchId: 'b1' },
    { ...chosen, batchId: 'b2' },
    { ...scheduled, batchId: 'b2' },
    { ...started, batchId: 'b2' },
    { ...succeeded, batchId: 'b2' },
    { ...onTap, batchId: 'b2' },
    bottle,
  ];
  const cases: [string, Event[], Event, RegExp][] = [
    ['an event for a batch that was never ordered', [], scheduled, /batch b1 was never ordered/],
    ['a batch ordered twice', [ordered], ordered, /batch b1 was already ordered/],
    [
      'a parent batch that was never ordered',
      [],
      { ...ordered, parentBatchId: 'b0' },
      /batch b0 was never ordered/,
    ],
    [
      'an attempt started before it was scheduled',
      [ordered, chosen, scheduled],
      { ...started, attempt: 2 },
      /plan#2 .*never scheduled/,
    ],
    [
      'an attempt finished before it was started',
      [ordered, chosen, scheduled],
      succeeded,
      /plan#1 .*never started/,
    ],
    [
      'an attempt scheduled twice',
      [ordered, chosen, scheduled],
      scheduled,
      /plan#1 .*already scheduled/,
    ],
    [
      'an attempt started twice',
      [ordered, chosen, scheduled, started],
      started,
      /plan#1 .*already started/,
    ],
    [
      'an attempt finished twice',
      [ordered, chosen, scheduled, started, succeeded],
      succeeded,
      /plan#1 .*already finished/,
    ],
    [
      'input for a step that never ran',
      [
        ordered,
        chosen,
        scheduled,
        started,
        { ...stuck, reason: { kind: 'needs_input', stepId: 'tests', questions: [question] } },
      ],
      { ...answered, stepId: 'tests' },
      /step tests of batch b1 was never scheduled/,
    ],
    [
      'a rewind to a step that never ran',
      lanes.stuck,
      { ...rewound, toStepId: 'tests' },
      /step tests of batch b1 was never scheduled/,
    ],
    [
      'a sub-order that already belongs to another order',
      [
        ordered,
        { type: 'batch.ordered', batchId: 'b2', order: { issue: 200 } },
        decomposed('b1', 101),
      ],
      decomposed('b2', 101),
      /sub-order 101 already belongs to order 100/,
    ],
    ['a bottle opened twice', bottled, bottle, /bottle k1 was already opened/],
    [
      'an effect applied twice',
      [ordered, scheduled, { type: 'effect.applied', key: prKey, result: { number: 7 } }],
      { type: 'effect.applied', key: prKey, result: { number: 8 } },
      /effect \["b1","plan",1,"pr"\] was already applied/,
    ],
    [
      'an effect of an attempt that was never scheduled',
      [ordered],
      { type: 'effect.applied', key: prKey, result: { number: 7 } },
      /attempt plan#1 of batch b1 was never scheduled/,
    ],
    [
      'a breakdown of a sub-order',
      [
        ordered,
        decomposed('b1', 101),
        { type: 'batch.ordered', batchId: 'b2', order: { issue: 101 }, parentBatchId: 'b1' },
      ],
      decomposed('b2', 300),
      /batch b2 brews sub-order 101; only an order can be decomposed/,
    ],
    [
      'an order listed as a sub-order of another order',
      [ordered, { type: 'batch.ordered', batchId: 'b2', order: { issue: 200 } }],
      decomposed('b1', 200),
      /issue 200 is an order, so it cannot be a sub-order/,
    ],
    [
      'an order listed as its own sub-order',
      [ordered],
      decomposed('b1', 100),
      /issue 100 is an order/,
    ],
  ];

  for (const [name, events, last, reason] of cases) {
    it(`refuses ${name}`, () => refused(events, last, reason));
  }
});

describe('admit lane rules (ADR 0025)', () => {
  // Which lanes each event that moves a batch may come from.
  const rules: [Event, Lane['kind'][]][] = [
    [chosen, ['ordered', 'conditioning', 'stuck']],
    [{ ...scheduled, stepId: 'review' }, ['ordered', 'brewing', 'conditioning']],
    [stuck, ['brewing', 'stuck']],
    [resumed, ['stuck']],
    [waiting, ['ordered', 'conditioning']],
    [rewound, ['stuck']],
    [onTap, ['brewing']],
    [cancelled, ['ordered', 'brewing', 'conditioning', 'stuck']],
    [answered, ['stuck']],
    [decomposed101(), ['ordered', 'brewing', 'conditioning', 'stuck']],
  ];
  for (const [event, allowed] of rules) {
    for (const [lane, events] of Object.entries(lanes)) {
      if (allowed.includes(lane as Lane['kind'])) {
        it(`accepts ${event.type} when the batch is ${lane}`, () => {
          assert.equal(admit(fold(events), [event]).kind, 'accepted');
        });
      } else {
        it(`refuses ${event.type} when the batch is ${lane}`, () => {
          refused(events, event, new RegExp(`batch b1 is ${lane}`));
        });
      }
    }
  }

  // An attempt can be scheduled or started in any lane; it starts and finishes only while brewing.
  for (const [event, events] of [
    [started, lanes.brewing.slice(0, 3)],
    [succeeded, lanes.brewing],
  ] as const) {
    it(`accepts ${event.type} when the batch is brewing`, () => {
      assert.equal(admit(fold([...events]), [event]).kind, 'accepted');
    });
    for (const [lane, prefix] of Object.entries(lanes).filter(([lane]) => lane !== 'brewing')) {
      it(`refuses ${event.type} when the batch is ${lane}`, () => {
        refused(prefix, event, new RegExp(`batch b1 is ${lane}; ${event.type} needs it brewing`));
      });
    }
  }

  it('names the lanes an event is allowed from', () => {
    refused(
      lanes.ordered,
      rewound,
      /^event 0 \(batch.rewound\): batch b1 is ordered; batch.rewound needs it stuck$/,
    );
    refused(lanes.on_tap, chosen, /needs it ordered, conditioning or stuck$/);
  });

  it('refuses a resume or rewind the Stuck batch does not offer', () => {
    const offering = (options: string[]) => [...lanes.brewing, { ...stuck, options } as Event];
    refused(offering(['answer', 'cancel']), resumed, /batch b1 does not offer retry/);
    refused(offering(['retry', 'cancel']), rewound, /batch b1 does not offer rewind/);
  });

  it('accepts answers only for the step whose questions made the batch Stuck', () => {
    const blocked: Event = {
      ...stuck,
      reason: { kind: 'blocked', stepId: 'plan', blockerKind: 'environment', summary: 'CI down' },
    };
    refused(
      [...lanes.brewing, blocked],
      answered,
      /batch b1 is not waiting for answers to step plan/,
    );
    const other: Event[] = [
      ...lanes.brewing,
      { ...scheduled, stepId: 'tests' },
      { ...started, stepId: 'tests' },
      stuck,
    ];
    refused(other, { ...answered, stepId: 'tests' }, /not waiting for answers to step tests/);
  });

  it("starts and finishes only a step's latest attempt", () => {
    const retried: Event[] = [...lanes.brewing, stuck, resumed, { ...scheduled, attempt: 2 }];
    refused(retried, succeeded, /attempt plan#1 of batch b1 is not the latest attempt of its step/);
    const twoScheduled: Event[] = [...lanes.brewing.slice(0, 3), { ...scheduled, attempt: 2 }];
    refused(
      twoScheduled,
      started,
      /attempt plan#1 of batch b1 is not the latest attempt of its step/,
    );
  });

  it('refuses a late start or finish of an attempt abandoned when the batch got Stuck (ADR 0025)', () => {
    const moved: Event[] = [
      ...lanes.brewing,
      { ...scheduled, stepId: 'tests' },
      stuck,
      resumed,
      { ...scheduled, stepId: 'review' },
    ];
    refused(moved, succeeded, /attempt plan#1 of batch b1 was abandoned when the batch got stuck/);
    refused(
      moved,
      { ...started, stepId: 'tests' },
      /attempt tests#1 of batch b1 was abandoned when the batch got stuck/,
    );
  });

  it('refuses a rewind without commits (ADR 0025)', () => {
    refused(lanes.stuck, { ...rewound, shas: {} }, /rewind needs the commit of each repository/);
  });

  it('accepts a release, and an effect of an attempt, whatever the lanes', () => {
    const release: Event = {
      type: 'release.observed',
      repo: 'acme/lib-core',
      package: 'lib-core',
      version: '2.4.0',
    };
    const effect: Event = {
      type: 'effect.applied',
      key: effectKey.encode({ batchId: 'b1', stepId: 'plan', attempt: 1, effect: 'comment' }),
      result: null,
    };
    for (const [lane, events] of Object.entries(lanes)) {
      // An effect is keyed by an attempt: a batch that never scheduled one has none (I4).
      const appended: Event[] = events.includes(scheduled) ? [release, effect] : [release];
      assert.equal(admit(fold(events), appended).kind, 'accepted', lane);
    }
  });
});

function decomposed101(): Event {
  return {
    type: 'order.decomposed',
    batchId: 'b1',
    subOrders: [{ issue: 101, repo: 'acme/api' }],
    dependencies: [],
  };
}

describe('admit keeps a sub-order in its repository', () => {
  const breakdown = (repo: string): Event => ({
    type: 'order.decomposed',
    batchId: 'b1',
    subOrders: [{ issue: 101, repo }],
    dependencies: [],
  });
  const subOrderBatch: Event = {
    type: 'batch.ordered',
    batchId: 'b2',
    order: { issue: 101 },
    parentBatchId: 'b1',
  };

  it('refuses a breakdown that moves a sub-order with batches to another repository', () => {
    refused(
      [ordered, breakdown('acme/api'), subOrderBatch],
      breakdown('acme/web'),
      /sub-order 101 has batches in acme\/api, so it cannot move to acme\/web/,
    );
  });

  it('accepts a breakdown that keeps the repository of a sub-order with batches', () => {
    const events = [ordered, breakdown('acme/api'), subOrderBatch];
    assert.equal(admit(fold(events), [breakdown('acme/api')]).kind, 'accepted');
  });

  it('rewinds the batch of a sub-order only to commits of its repository (ADR 0025)', () => {
    const stuckSubOrder: Event[] = [
      ordered,
      breakdown('acme/api'),
      subOrderBatch,
      ...[chosen, scheduled, started, stuck].map((event) => ({ ...event, batchId: 'b2' }) as Event),
    ];
    const rewind = (shas: Record<string, string>): Event => ({ ...rewound, batchId: 'b2', shas });
    const sha = 'a'.repeat(40);
    assert.equal(admit(fold(stuckSubOrder), [rewind({ 'acme/api': sha })]).kind, 'accepted');
    refused(stuckSubOrder, rewind({ 'acme/web': sha }), /sub-order 101 writes only in acme\/api/);
    refused(
      stuckSubOrder,
      rewind({ 'acme/api': sha, 'acme/web': sha }),
      /sub-order 101 writes only in acme\/api/,
    );
  });

  it('accepts a breakdown that moves a sub-order without batches', () => {
    const events = [ordered, breakdown('acme/api')];
    assert.equal(admit(fold(events), [breakdown('acme/web')]).kind, 'accepted');
  });
});

describe('admit bottles only finished sub-orders of its repository (ADR 0013)', () => {
  const subOrders: Event = {
    type: 'order.decomposed',
    batchId: 'b1',
    subOrders: [
      { issue: 101, repo: 'acme/api' },
      { issue: 102, repo: 'acme/api' },
      { issue: 103, repo: 'acme/web' },
    ],
    dependencies: [],
  };
  // A batch for each sub-order; only 101's and 103's are on tap.
  const brew = (batchId: string, issue: number, tap: boolean): Event[] => [
    { type: 'batch.ordered', batchId, order: { issue }, parentBatchId: 'b1' },
    { ...chosen, batchId },
    { ...scheduled, batchId },
    { ...started, batchId },
    ...(tap
      ? [
          { ...succeeded, batchId },
          { ...onTap, batchId },
        ]
      : []),
  ];
  const events: Event[] = [
    ordered,
    subOrders,
    ...brew('b101', 101, true),
    ...brew('b102', 102, false),
    ...brew('b103', 103, true),
  ];
  const bottle = (repo: string, issues: number[]): Event => ({
    type: 'bottle.opened',
    bottleId: 'k1',
    repo,
    subOrders: issues,
    pullRequest,
  });

  it('accepts a bottle of sub-orders of its repository with a batch on tap', () => {
    assert.equal(admit(fold(events), [bottle('acme/api', [101])]).kind, 'accepted');
  });

  it('refuses a sub-order that does not exist', () => {
    refused(events, bottle('acme/api', [101, 999]), /sub-order 999 does not exist/);
  });

  it('refuses an order listed as a sub-order', () => {
    refused(events, bottle('acme/api', [100]), /sub-order 100 does not exist/);
  });

  it('refuses a sub-order of another repository', () => {
    refused(
      events,
      bottle('acme/api', [101, 103]),
      /sub-order 103 targets acme\/web, not acme\/api/,
    );
  });

  it('refuses a sub-order without a batch on tap', () => {
    refused(events, bottle('acme/api', [101, 102]), /sub-order 102 has no batch on tap/);
  });
});
