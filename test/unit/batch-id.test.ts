import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { nextBatchId } from '../../src/engine/batch-id.ts';
import { emptyState, fold } from '../../src/engine/fold.ts';
import { PathSafeId } from '../../src/schemas/ids.ts';

const ordered = (batchId: string, issue: number) =>
  ({
    type: 'batch.ordered',
    batchId,
    order: { issue },
    routeBy: '2026-12-31T00:00:00.000Z',
  }) as const;

describe('nextBatchId', () => {
  it('numbers the first batch of an issue 1', () => {
    assert.equal(nextBatchId(emptyState, 42), '42-1');
  });

  it('takes the first number no batch uses yet', () => {
    const state = fold([ordered('42-1', 42), ordered('42-3', 42), ordered('7-2', 7)]);
    assert.equal(nextBatchId(state, 42), '42-2');
    assert.equal(nextBatchId(state, 7), '7-1');
  });

  it('skips an id another issue uses', () => {
    assert.equal(nextBatchId(fold([ordered('42-1', 9)]), 42), '42-2');
  });

  it('gives ids that pass PathSafeId (ADR 0024), up to the largest issue number', () => {
    for (const issue of [1, 42, 1_000_000, Number.MAX_SAFE_INTEGER]) {
      const id = nextBatchId(emptyState, issue);
      assert.ok(PathSafeId.safeParse(id).success, id);
    }
  });

  for (const issue of [0, -1, 1.5, Number.NaN]) {
    it(`refuses issue ${issue}`, () => {
      assert.throws(() => nextBatchId(emptyState, issue), /issue must be a positive integer/);
    });
  }
});
