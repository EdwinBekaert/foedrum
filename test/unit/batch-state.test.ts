// What a batch is to a person (ADR 0379): one function from a batch's lane to running, waiting for
// you and for what, queued, or done and how, and the one line of words every surface shows.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  type BatchState,
  batchState,
  type StateContext,
  stateLine,
} from '../../src/engine/batch-state.ts';
import type { Batch, Lane } from '../../src/engine/fold.ts';
import type { SubOrderRow } from '../../src/engine/order-end.ts';
import type { StuckReason } from '../../src/schemas/events.ts';

const at = '2026-11-11T09:00:00.000Z';
const pr = 'https://github.com/alice/web/pull/12';
const other = 'https://github.com/alice/web/pull/13';

/** Batch `7-1` in `lane`, with `fields`. */
const batch = (lane: Lane, fields: Partial<Batch> = {}): Batch => ({
  id: '7-1',
  issue: 7,
  lane,
  steps: new Map(),
  rewinds: [],
  ...fields,
});
const stuck = (reason: StuckReason): Lane => ({
  kind: 'stuck',
  reason,
  options: ['retry', 'cancel'],
  remindAt: at,
});
const approval = {
  stepId: 'plan',
  attempt: 1,
  plan: '0123456789abcdef',
  by: 'grace',
  via: 'terminal',
  at,
} as const;
const split = batch({ kind: 'on_tap', pullRequests: [] }, { approval, decomposed: true });
const row = (subOrder: number, fields: Partial<SubOrderRow> = {}): SubOrderRow => ({
  subOrder,
  repo: 'alice/web',
  state: 'none',
  ...fields,
});
const of = (lane: Lane, context?: StateContext, fields?: Partial<Batch>): BatchState =>
  batchState(batch(lane, fields), context);

describe('batchState', () => {
  it('a batch a brewer works on is running', () => {
    assert.deepEqual(of({ kind: 'brewing' }), { kind: 'running' });
  });

  it('a paused batch is queued by the pause, while a paused Stuck one still waits for you', () => {
    assert.deepEqual(of({ kind: 'brewing' }, { paused: true }), {
      kind: 'queued',
      by: { kind: 'pause' },
    });
    const review = stuck({ kind: 'plan_review', stepId: 'plan', attempt: 1 });
    assert.equal(of(review, { paused: true }).kind, 'waiting');
  });

  it('a brewing batch with nothing running under a closed usage window is queued by the limit', () => {
    assert.deepEqual(of({ kind: 'brewing' }, { usageHeld: true }), {
      kind: 'queued',
      by: { kind: 'usage-limit' },
    });
    const running = new Map([
      [
        'implement',
        {
          id: 'implement',
          inputs: [],
          attempts: new Map([[1, { phase: 'started', attempt: 1, deadlineAt: at } as const]]),
        },
      ],
    ]);
    assert.deepEqual(of({ kind: 'brewing' }, { usageHeld: true }, { steps: running }), {
      kind: 'running',
    });
  });

  it('an ordered batch is queued for its recipe, a conditioning one for what it waits on', () => {
    assert.deepEqual(of({ kind: 'ordered', routeBy: at }), {
      kind: 'queued',
      by: { kind: 'recipe' },
    });
    const on = { kind: 'merge', pullRequest: pr } as const;
    assert.deepEqual(of({ kind: 'conditioning', on, remindAt: at }), {
      kind: 'queued',
      by: { kind: 'wait', on },
    });
  });

  it('each Stuck reason waits for you, for what a person does about it', () => {
    const question = { q: 'Which?', options: ['a', 'b'], recommended: 'a', whyBlocking: 'Both.' };
    const cases: [StuckReason, string][] = [
      [{ kind: 'plan_review', stepId: 'plan', attempt: 1 }, 'approve-plan'],
      [{ kind: 'needs_input', stepId: 'plan', questions: [question] }, 'answer'],
      [
        {
          kind: 'order_changed',
          stepId: 'plan',
          upTo: at,
          more: 0,
          changes: [{ what: 'title', at }],
        },
        'answer',
      ],
      [{ kind: 'waiting_for_session', stepId: 'plan' }, 'open-session'],
      [{ kind: 'routing', deadlineAt: at }, 'choose-recipe'],
      [{ kind: 'deadline_passed', stepId: 'plan', deadlineAt: at }, 'look-at-failure'],
      [{ kind: 'stopped', stepId: 'plan', by: 'ann', via: 'terminal' }, 'look-at-failure'],
    ];
    for (const [reason, kind] of cases) {
      assert.deepEqual(of(stuck(reason)), { kind: 'waiting', for: { kind } }, reason.kind);
    }
  });

  it('a Stuck reason this Foedrum does not know still waits for you to look at it', () => {
    const unknown = { kind: 'from-a-newer-foedrum' } as unknown as StuckReason;
    assert.deepEqual(of(stuck(unknown)), { kind: 'waiting', for: { kind: 'look-at-failure' } });
  });

  it('a batch on tap with an open pull request waits for you to review and merge it', () => {
    assert.deepEqual(
      of(
        { kind: 'on_tap', pullRequests: [pr, other] },
        {},
        { pullRequestEnds: { [pr]: 'merged' } },
      ),
      { kind: 'waiting', for: { kind: 'review-and-merge', pullRequests: [other] } },
    );
  });

  it('a batch is done when every pull request merged, or one closed without merging', () => {
    const lane: Lane = { kind: 'on_tap', pullRequests: [pr, other] };
    assert.deepEqual(of(lane, {}, { pullRequestEnds: { [pr]: 'merged', [other]: 'merged' } }), {
      kind: 'done',
      how: 'merged',
    });
    assert.deepEqual(of(lane, {}, { pullRequestEnds: { [pr]: 'merged', [other]: 'closed' } }), {
      kind: 'done',
      how: 'closed without merging',
    });
  });

  it('a cancelled batch is done, and so is one whose recipe opens no pull request', () => {
    assert.deepEqual(of({ kind: 'cancelled', by: 'ann', via: 'terminal' }), {
      kind: 'done',
      how: 'cancelled',
    });
    assert.deepEqual(of({ kind: 'on_tap', pullRequests: [] }), {
      kind: 'done',
      how: 'no pull request',
    });
  });

  it('an approved plan with no sub-order opened yet is queued for them', () => {
    const approved = batch({ kind: 'on_tap', pullRequests: [] }, { approval });
    assert.deepEqual(batchState(approved), { kind: 'queued', by: { kind: 'sub-orders' } });
  });

  it("a split order is done once every sub-order merged, whatever its sub-orders' batches say", () => {
    const merged = { state: 'merged', pullRequest: pr } as const;
    assert.deepEqual(
      batchState(split, {
        subOrders: [
          { row: row(8, merged), latest: { kind: 'done', how: 'merged' } },
          { row: row(9, { ...merged, pullRequest: other }) },
        ],
      }),
      { kind: 'done', how: 'merged' },
    );
  });

  it("a split order takes its sub-orders' most pressing state: waiting, then running, then queued", () => {
    const queued: BatchState = { kind: 'queued', by: { kind: 'recipe' } };
    const waiting: BatchState = {
      kind: 'waiting',
      for: { kind: 'review-and-merge', pullRequests: [pr] },
    };
    const sub = (latest: BatchState | undefined, n: number) => ({
      row: row(n, { state: 'open' }),
      ...(latest === undefined ? {} : { latest }),
    });
    assert.deepEqual(
      batchState(split, {
        subOrders: [sub(queued, 8), sub({ kind: 'running' }, 9), sub(waiting, 10)],
      }),
      { ...waiting, subOrder: 10 },
    );
    assert.deepEqual(
      batchState(split, { subOrders: [sub(queued, 8), sub({ kind: 'running' }, 9)] }),
      { kind: 'running', subOrder: 9 },
    );
    assert.deepEqual(batchState(split, { subOrders: [sub(undefined, 8), sub(queued, 9)] }), {
      kind: 'queued',
      by: { kind: 'not-ordered' },
      subOrder: 8,
    });
  });

  it('a sub-order that keeps its order open waits for you to look at it, with why', () => {
    assert.deepEqual(
      batchState(split, {
        subOrders: [
          { row: row(8, { state: 'open' }), latest: { kind: 'running' } },
          { row: row(9, { state: 'closed', left: 'closed without merging' }) },
        ],
      }),
      {
        kind: 'waiting',
        for: { kind: 'look-at-failure', left: 'closed without merging' },
        subOrder: 9,
      },
    );
  });
});

describe('stateLine', () => {
  it('says each state in plain words, and for what a batch waits', () => {
    const cases: [BatchState, string][] = [
      [{ kind: 'running' }, 'Running'],
      [{ kind: 'running', subOrder: 9 }, 'Running: sub-order #9'],
      [{ kind: 'waiting', for: { kind: 'approve-plan' } }, 'Waiting for you: approve the plan'],
      [{ kind: 'waiting', for: { kind: 'answer' } }, 'Waiting for you: answer a question'],
      [
        { kind: 'waiting', for: { kind: 'review-and-merge', pullRequests: [pr] } },
        'Waiting for you: review and merge the pull request',
      ],
      [
        { kind: 'waiting', for: { kind: 'review-and-merge', pullRequests: [pr, other] } },
        'Waiting for you: review and merge the pull requests',
      ],
      [{ kind: 'waiting', for: { kind: 'open-session' } }, 'Waiting for you: open its session'],
      [{ kind: 'waiting', for: { kind: 'choose-recipe' } }, 'Waiting for you: choose a recipe'],
      [
        { kind: 'waiting', for: { kind: 'look-at-failure' } },
        'Waiting for you: look at a failure Foedrum could not get past',
      ],
      [
        {
          kind: 'waiting',
          for: { kind: 'look-at-failure', left: 'closed without merging' },
          subOrder: 9,
        },
        'Waiting for you: look at sub-order #9, closed without merging',
      ],
      [
        { kind: 'waiting', for: { kind: 'approve-plan' }, subOrder: 9 },
        'Waiting for you: approve the plan of sub-order #9',
      ],
      [{ kind: 'queued', by: { kind: 'recipe' } }, 'Queued: waiting for a recipe'],
      [
        { kind: 'queued', by: { kind: 'wait', on: { kind: 'merge', pullRequest: pr } } },
        `Queued: waiting for the merge of ${pr}`,
      ],
      [{ kind: 'queued', by: { kind: 'pause' } }, 'Queued: paused'],
      [{ kind: 'queued', by: { kind: 'usage-limit' } }, 'Queued: held by a usage limit'],
      [{ kind: 'queued', by: { kind: 'sub-orders' } }, 'Queued: its sub-orders are being opened'],
      [
        { kind: 'queued', by: { kind: 'not-ordered' }, subOrder: 8 },
        'Queued: sub-order #8 is not ordered yet',
      ],
      [
        { kind: 'queued', by: { kind: 'recipe' }, subOrder: 8 },
        'Queued: sub-order #8 waits for a recipe',
      ],
      [{ kind: 'queued', by: { kind: 'pause' }, subOrder: 8 }, 'Queued: sub-order #8 is paused'],
      [
        { kind: 'queued', by: { kind: 'usage-limit' }, subOrder: 8 },
        'Queued: sub-order #8 is held by a usage limit',
      ],
      [
        {
          kind: 'queued',
          by: { kind: 'wait', on: { kind: 'merge', pullRequest: pr } },
          subOrder: 8,
        },
        `Queued: sub-order #8 waits for the merge of ${pr}`,
      ],
      [{ kind: 'done', how: 'merged' }, 'Done: merged'],
      [{ kind: 'done', how: 'closed without merging' }, 'Done: closed without merging'],
      [{ kind: 'done', how: 'cancelled' }, 'Done: cancelled'],
      [{ kind: 'done', how: 'no pull request' }, 'Done: finished with no pull request'],
    ];
    for (const [state, line] of cases) assert.equal(stateLine(state), line);
  });
});
