// The archive of finished batches (ADR 0380): which batches a cleanup takes, what the fold keeps of
// one it took, and that nothing reads or writes its own events after.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { admit } from '../../src/engine/admit.ts';
import { type ArchiveFacts, archivable, archivedOf } from '../../src/engine/archive.ts';
import { nextBatchId, targetBatchId } from '../../src/engine/batch-id.ts';
import { claimOfOrder, claimOrderOf } from '../../src/engine/claim-orders.ts';
import { effectKey } from '../../src/engine/effect-key.ts';
import { batchEnded, fold, foldedBatch, type State } from '../../src/engine/fold.ts';
import { orderEffects } from '../../src/engine/issue-claims.ts';
import { batchOf } from '../../src/engine/state-branch.ts';
import type { Event, OrderRef } from '../../src/schemas/events.ts';

const routeBy = '2026-12-31T00:00:00.000Z';
const pr = (n: number): string => `https://github.com/acme/web/pull/${n}`;
const who = { by: 'ada', via: 'terminal' } as const;

const ordered = (batchId: string, order: OrderRef, parentBatchId?: string): Event => ({
  type: 'batch.ordered',
  batchId,
  order,
  routeBy,
  ...(parentBatchId === undefined ? {} : { parentBatchId }),
});
const onTap = (batchId: string, ...pullRequests: string[]): Event => ({
  type: 'batch.on_tap',
  batchId,
  pullRequests,
});
const merged = (batchId: string, pullRequest: string): Event => ({
  type: 'pull_request.ended',
  batchId,
  pullRequest,
  state: 'merged',
});
const applied = (batchId: string, effect: string, result: unknown): Event => ({
  type: 'effect.applied',
  key: effectKey.encode({ batchId, effect }),
  result,
});
const cancelled = (batchId: string): Event => ({ type: 'batch.cancelled', batchId, ...who });

/** A batch of Brewery issue `issue` whose one pull request merged. */
const mergedBatch = (batchId: string, issue: number, n: number): Event[] => [
  ordered(batchId, { issue }),
  onTap(batchId, pr(n)),
  merged(batchId, pr(n)),
];

const none: ArchiveFacts = { due: () => false, leased: new Set() };
const idsOf = (state: State, facts: ArchiveFacts = none): string[] =>
  archivable(state, facts).map(({ id }) => id);
const archive = (state: State, batchId: string): State =>
  fold([archivedOf(state, foldedBatch(state, batchId))], state);

describe('batchEnded (ADR 0345, ADR 0380)', () => {
  it('an on-tap batch with no pull request has ended once the engine closed its issue', () => {
    const tapped = fold([ordered('3-1', { issue: 3 }), onTap('3-1')]);
    assert.equal(batchEnded(foldedBatch(tapped, '3-1')), false);
    const closed = fold([applied('3-1', 'close.issue', null)], tapped);
    assert.equal(batchEnded(foldedBatch(closed, '3-1')), true);
  });
});

describe('the archive in the fold (ADR 0380)', () => {
  const finished = fold([
    ...mergedBatch('7-1', 7, 3),
    applied('7-1', 'plan.1', { comment: 900, digest: '0123456789abcdef' }),
    applied('7-1', 'close.issue', null),
    ordered('8-1', { issue: 8 }),
  ]);

  it('a batch in archive/ is neither loaded nor written by the engine', () => {
    const event = archivedOf(finished, foldedBatch(finished, '7-1'));
    assert.deepStrictEqual(event, {
      type: 'batch.archived',
      batchId: '7-1',
      order: { issue: 7 },
      breweryIssue: 7,
      planComment: 900,
      ended: 'merged',
    });
    const live = fold([event], finished);
    assert.equal(live.batches.has('7-1'), false);
    assert.deepStrictEqual(live.archived.get('7-1'), {
      batchId: '7-1',
      order: { issue: 7 },
      breweryIssue: 7,
      planComment: 900,
      ended: 'merged',
    });

    // The same state as a store rebuilt from batches/ alone, which never reads 7-1's own log.
    const rebuilt = fold([ordered('8-1', { issue: 8 }), event]);
    for (const part of [
      'batches',
      'orders',
      'subOrders',
      'effects',
      'merges',
      'archived',
    ] as const) {
      assert.deepStrictEqual(live[part], rebuilt[part], part);
    }

    // Nothing writes to it, and its id is never ordered again.
    for (const write of [
      cancelled('7-1'),
      applied('7-1', 'plan.2', { comment: 900, digest: 'fedcba9876543210' }),
      event,
      ordered('7-1', { issue: 7 }),
    ]) {
      assert.equal(admit(live, [write]).kind, 'refused', write.type);
    }
  });

  it('refuses to archive a batch that has not ended', () => {
    const live = fold([ordered('9-1', { issue: 9 })]);
    const event: Event = {
      type: 'batch.archived',
      batchId: '9-1',
      order: { issue: 9 },
      breweryIssue: 9,
      ended: 'cancelled',
    };
    assert.equal(admit(live, [event]).kind, 'refused');
    assert.equal(admit(fold([cancelled('9-1')], live), [event]).kind, 'accepted');
  });

  it('the next batch of an issue never takes an archived batch id', () => {
    const state = archive(
      fold([
        ordered('7-1', { issue: 7 }),
        cancelled('7-1'),
        ordered('web-7', { issue: 7, repo: 'acme/web' }),
        cancelled('web-7'),
      ]),
      '7-1',
    );
    assert.equal(nextBatchId(state, 7), '7-2');
    assert.equal(targetBatchId(archive(state, 'web-7'), 'web', 7), 'web-7-2');
  });

  it("a later claim of an archived batch's issue keeps the Brewery issue it opened", () => {
    const claimed = { issue: 7, repo: 'acme/web' };
    const first = fold([
      ordered('web-7', claimed),
      applied('web-7', orderEffects.open, 41),
      cancelled('web-7'),
    ]);
    const state = fold([ordered('web-7-2', claimed)], archive(first, 'web-7'));
    assert.deepStrictEqual(claimOrderOf(state, 'web-7-2'), { earlier: { issue: 41 }, issue: 41 });
    assert.equal(claimOfOrder(state, 41)?.id, 'web-7-2');
  });
});

describe('the archive folds as a rebuild from batches/ alone: regression tests (ADR 0380)', () => {
  const parts = ['batches', 'orders', 'subOrders', 'effects', 'merges', 'releases', 'archived'];
  /** `log` folded live, then archived in `order`, against the log without those batches' events. */
  const sameAsRebuilt = (log: readonly Event[], order: readonly string[]): void => {
    let live = fold(log);
    const archived: Event[] = [];
    for (const batchId of order) {
      const event = archivedOf(live, foldedBatch(live, batchId));
      archived.push(event);
      live = fold([event], live);
    }
    const kept = log.filter((event) => !order.includes(batchOf(event) ?? ''));
    const rebuilt = fold([...kept, ...archived]);
    for (const part of parts) {
      assert.deepStrictEqual(live[part as keyof State], rebuilt[part as keyof State], part);
    }
  };

  it('moves the later merges and releases down past the archived merge', () => {
    sameAsRebuilt(
      [
        ...mergedBatch('7-1', 7, 3),
        ...mergedBatch('8-1', 8, 4),
        { type: 'release.observed', repo: 'acme/web', package: 'web', version: '1.0.0' },
        ...mergedBatch('9-1', 9, 5),
      ],
      ['7-1'],
    );
  });

  it('takes a split family with its breakdown, its sub-orders and their dependencies', () => {
    sameAsRebuilt(
      [
        ordered('6-1', { issue: 6 }),
        {
          type: 'order.decomposed',
          batchId: '6-1',
          subOrders: [
            { issue: 61, repo: 'acme/web' },
            { issue: 62, repo: 'acme/web' },
          ],
          dependencies: [{ subOrder: 62, blockedBy: 61, kind: 'code' }],
        },
        onTap('6-1'),
        ordered('61-1', { issue: 61 }, '6-1'),
        onTap('61-1', pr(61)),
        merged('61-1', pr(61)),
        ordered('62-1', { issue: 62 }, '6-1'),
        onTap('62-1', pr(62)),
        merged('62-1', pr(62)),
        applied('6-1', 'close.issue', null),
      ],
      ['6-1', '61-1', '62-1'],
    );
  });
});

describe('archivable (ADR 0380)', () => {
  it("the cleanup leaves a running attempt's files and a Stuck batch alone", () => {
    const state = fold([
      ...mergedBatch('1-1', 1, 1),
      ordered('2-1', { issue: 2 }),
      { type: 'step.scheduled', batchId: '2-1', stepId: 'plan', attempt: 1, deadlineAt: routeBy },
      { type: 'step.started', batchId: '2-1', stepId: 'plan', attempt: 1 },
      ordered('3-1', { issue: 3 }),
      {
        type: 'batch.stuck',
        batchId: '3-1',
        reason: { kind: 'routing', deadlineAt: routeBy },
        options: ['retry', 'recipe', 'cancel'],
        remindAt: routeBy,
      },
    ]);
    assert.deepStrictEqual(idsOf(state), ['1-1']);
  });

  it('takes a cancelled batch and one whose pull requests all ended, in the order they were ordered', () => {
    const state = fold([
      ordered('5-1', { issue: 5 }),
      ...mergedBatch('4-1', 4, 4),
      cancelled('5-1'),
    ]);
    assert.deepStrictEqual(idsOf(state), ['5-1', '4-1']);
  });

  it('leaves a batch with one of two pull requests still open', () => {
    const state = fold([
      ordered('4-1', { issue: 4 }),
      onTap('4-1', pr(4), pr(5)),
      merged('4-1', pr(4)),
    ]);
    assert.deepStrictEqual(idsOf(state), []);
  });

  it('leaves a batch with an effect due, a lease or a failing mark', () => {
    const all = fold([
      ...mergedBatch('1-1', 1, 1),
      ...mergedBatch('2-1', 2, 2),
      ordered('3-1', { issue: 3 }),
      cancelled('3-1'),
    ]);
    assert.deepStrictEqual(idsOf(all), ['1-1', '2-1', '3-1']);
    assert.deepStrictEqual(idsOf(all, { due: (id) => id === '1-1', leased: new Set() }), [
      '2-1',
      '3-1',
    ]);
    assert.deepStrictEqual(idsOf(all, { due: () => false, leased: new Set(['2-1']) }), [
      '1-1',
      '3-1',
    ]);
    const marked = fold(
      [{ type: 'batch.failing', batchId: '3-1', pass: 'effects', summary: 'boom', since: routeBy }],
      all,
    );
    assert.deepStrictEqual(idsOf(marked), ['1-1', '2-1']);
  });

  it('takes a split order only with every batch of its sub-orders, once its issue is closed', () => {
    const parent = fold([
      ordered('6-1', { issue: 6 }),
      onTap('6-1'),
      ordered('61-1', { issue: 61 }, '6-1'),
      onTap('61-1', pr(61)),
      merged('61-1', pr(61)),
      ordered('62-1', { issue: 62 }, '6-1'),
    ]);
    // Its issue is open, and a sub-order brews: none of the family goes.
    assert.deepStrictEqual(idsOf(parent), []);
    const ended = fold(
      [onTap('62-1', pr(62)), merged('62-1', pr(62)), applied('6-1', 'close.issue', null)],
      parent,
    );
    assert.deepStrictEqual(idsOf(ended), ['6-1', '61-1', '62-1']);
    // One with an effect due keeps the whole family.
    assert.deepStrictEqual(idsOf(ended, { due: (id) => id === '62-1', leased: new Set() }), []);
  });
});
