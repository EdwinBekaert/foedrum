// The cleanup's choice of the batches it shelves (ADR 0380): only finished ones, nothing with an
// effect due, a mark, a lease or a line not yet on the state branch, an order with its sub-orders
// together, and a later batch of an issue only with every earlier one.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { type ArchiveFacts, archivable } from '../../src/engine/archive.ts';
import { effectKey } from '../../src/engine/effect-key.ts';
import { batchEnded, fold, foldedBatch, type State } from '../../src/engine/fold.ts';
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

const none: ArchiveFacts = { due: () => false, leased: new Set(), unpushed: () => false };
const idsOf = (state: State, facts: ArchiveFacts = none): string[] =>
  archivable(state, facts).map(({ id }) => id);

describe('batchEnded (ADR 0345, ADR 0380)', () => {
  it('an on-tap batch with no pull request has ended once the engine closed its issue', () => {
    const tapped = fold([ordered('3-1', { issue: 3 }), onTap('3-1')]);
    assert.equal(batchEnded(foldedBatch(tapped, '3-1')), false);
    const closed = fold([applied('3-1', 'close.issue', null)], tapped);
    assert.equal(batchEnded(foldedBatch(closed, '3-1')), true);
  });

  it('an on-tap batch with no pull request has not ended on its closing comment or a status revision: regression test', () => {
    const tapped = fold([
      ordered('3-1', { issue: 3 }),
      onTap('3-1'),
      applied('3-1', 'close.comment', 7),
      applied('3-1', 'status.1', { comment: 8, digest: '0123456789abcdef' }),
    ]);
    assert.equal(batchEnded(foldedBatch(tapped, '3-1')), false);
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
    assert.deepStrictEqual(
      idsOf(all, { due: (id) => id === '1-1', leased: new Set(), unpushed: () => false }),
      ['2-1', '3-1'],
    );
    assert.deepStrictEqual(
      idsOf(all, { due: () => false, leased: new Set(['2-1']), unpushed: () => false }),
      ['1-1', '3-1'],
    );
    const marked = fold(
      [{ type: 'batch.failing', batchId: '3-1', pass: 'effects', summary: 'boom', since: routeBy }],
      all,
    );
    assert.deepStrictEqual(idsOf(marked), ['1-1', '2-1']);
  });

  it('leaves a batch with an event the state branch does not have yet, or an out doc still kept', () => {
    const all = fold([...mergedBatch('1-1', 1, 1), ...mergedBatch('2-1', 2, 2)]);
    assert.deepStrictEqual(idsOf(all, { ...none, unpushed: (id) => id === '1-1' }), ['2-1']);
  });

  it('takes a later batch of an issue only once every earlier one goes too, so they go in the order they were ordered', () => {
    const claimed = { issue: 7, repo: 'acme/web' };
    const state = fold([
      ordered('web-7', claimed),
      cancelled('web-7'),
      ordered('web-7-2', claimed),
      cancelled('web-7-2'),
      ordered('8-1', { issue: 8 }),
      cancelled('8-1'),
    ]);
    const facts = { ...none, due: (id: string) => id === 'web-7' };
    assert.deepStrictEqual(idsOf(state, facts), ['8-1']);
    assert.deepStrictEqual(idsOf(state), ['web-7', 'web-7-2', '8-1']);
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
    assert.deepStrictEqual(
      idsOf(ended, { due: (id) => id === '62-1', leased: new Set(), unpushed: () => false }),
      [],
    );
  });

  it('keeps a whole split family whose order an earlier batch of its issue holds back', () => {
    const state = fold([
      ordered('6-1', { issue: 6 }),
      cancelled('6-1'),
      ordered('6-2', { issue: 6 }),
      onTap('6-2'),
      ordered('61-1', { issue: 61 }, '6-2'),
      onTap('61-1', pr(61)),
      merged('61-1', pr(61)),
      applied('6-2', 'close.issue', null),
    ]);
    assert.deepStrictEqual(
      idsOf(state, { due: (id) => id === '6-1', leased: new Set(), unpushed: () => false }),
      [],
    );
    assert.deepStrictEqual(idsOf(state), ['6-1', '6-2', '61-1']);
  });
});
