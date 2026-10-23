// The Brewery issue that is the order of a claimed target-repository issue (ADR 0144): which one a
// batch has, from the ledger alone, how ordering again finds it, and how a batch is named.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { claimOfOrder, claimOrderOf, orderName } from '../../src/engine/claim-orders.ts';
import { effectKey } from '../../src/engine/effect-key.ts';
import { fold, type State } from '../../src/engine/fold.ts';
import type { Event } from '../../src/schemas/events.ts';

const routeBy = '2026-10-23T10:00:00.000Z';
const ordered = (batchId: string, issue: number, repo?: string): Event => ({
  type: 'batch.ordered',
  batchId,
  order: repo === undefined ? { issue } : { issue, repo },
  routeBy,
});
const applied = (batchId: string, effect: string, result: unknown = null): Event => ({
  type: 'effect.applied',
  key: effectKey.encode({ batchId, effect }),
  result,
});
const stateOf = (...events: Event[]): State => fold(events);

describe('claimOrderOf', () => {
  it('has none for a batch of a Brewery issue, or one never ordered', () => {
    const state = stateOf(ordered('7-1', 7));
    assert.deepStrictEqual(claimOrderOf(state, '7-1'), {});
    assert.deepStrictEqual(claimOrderOf(state, 'web-7'), {});
  });

  it('has none until the batch opened its Brewery issue, then that one', () => {
    const before = stateOf(ordered('web-7', 7, 'acme/web'));
    assert.deepStrictEqual(claimOrderOf(before, 'web-7'), {});
    const after = fold([applied('web-7', 'order.issue', 200)], before);
    assert.deepStrictEqual(claimOrderOf(after, 'web-7'), { issue: 200 });
  });

  it('gives a batch ordered again the Brewery issue an earlier batch of the issue opened', () => {
    const state = stateOf(
      ordered('web-7', 7, 'acme/web'),
      applied('web-7', 'order.issue', 200),
      ordered('web-7-2', 7, 'Acme/Web'),
    );
    assert.deepStrictEqual(claimOrderOf(state, 'web-7-2'), {
      earlier: { issue: 200, closed: false },
      issue: 200,
    });
  });

  it('says when a release closed it, and when a later batch reopened it', () => {
    const closed = stateOf(
      ordered('web-7', 7, 'acme/web'),
      applied('web-7', 'order.issue', 200),
      applied('web-7', 'release.order'),
      ordered('web-7-2', 7, 'acme/web'),
    );
    assert.deepStrictEqual(claimOrderOf(closed, 'web-7-2').earlier, { issue: 200, closed: true });
    const reopened = fold(
      [applied('web-7-2', 'order.reopen'), ordered('web-7-3', 7, 'acme/web')],
      closed,
    );
    assert.deepStrictEqual(claimOrderOf(reopened, 'web-7-3').earlier, {
      issue: 200,
      closed: false,
    });
  });

  it('counts only the batches of the same issue in the same repository', () => {
    const state = stateOf(
      ordered('api-7', 7, 'acme/api'),
      applied('api-7', 'order.issue', 300),
      ordered('web-8', 8, 'acme/web'),
      applied('web-8', 'order.issue', 301),
      ordered('web-7', 7, 'acme/web'),
    );
    assert.deepStrictEqual(claimOrderOf(state, 'web-7'), {});
  });

  it('ignores a recorded result that is no positive integer', () => {
    const state = stateOf(ordered('web-7', 7, 'acme/web'), applied('web-7', 'order.issue', '200'));
    assert.deepStrictEqual(claimOrderOf(state, 'web-7'), {});
  });
});

describe('claimOfOrder', () => {
  it('finds the latest claimed batch whose order is the Brewery issue', () => {
    const state = stateOf(
      ordered('web-7', 7, 'acme/web'),
      applied('web-7', 'order.issue', 200),
      ordered('web-7-2', 7, 'acme/web'),
      ordered('12-1', 12),
    );
    assert.equal(claimOfOrder(state, 200)?.id, 'web-7-2');
    assert.equal(claimOfOrder(state, 12), undefined);
    assert.equal(claimOfOrder(state, 7), undefined);
  });
});

describe('orderName', () => {
  const state = stateOf(
    ordered('12-1', 12),
    ordered('web-7', 7, 'acme/web'),
    applied('web-7', 'order.issue', 200),
    ordered('api-9', 9, 'acme/api'),
  );
  const name = (batchId: string): string => {
    const batch = state.batches.get(batchId);
    return batch === undefined ? assert.fail(batchId) : orderName(state, batch);
  };

  it('names a Brewery issue #<n>', () => {
    assert.equal(name('12-1'), '#12');
  });

  it('names a claimed issue by its Brewery issue and <alias>#<n>', () => {
    assert.equal(name('web-7'), '#200 (web#7)');
  });

  it('names a claimed issue <alias>#<n> until its Brewery issue is opened', () => {
    assert.equal(name('api-9'), 'api#9');
  });
});
