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
    assert.deepStrictEqual(claimOrderOf(state, 'web-7-2'), { earlier: { issue: 200 }, issue: 200 });
  });

  it('keeps it through the releases that closed it and the batches that reopened it', () => {
    const state = stateOf(
      ordered('web-7', 7, 'acme/web'),
      applied('web-7', 'order.issue', 200),
      applied('web-7', 'release.order'),
      ordered('web-7-2', 7, 'acme/web'),
      applied('web-7-2', 'order.reopen'),
      applied('web-7-2', 'release.order'),
      ordered('web-7-3', 7, 'acme/web'),
    );
    assert.deepStrictEqual(claimOrderOf(state, 'web-7-3'), { earlier: { issue: 200 }, issue: 200 });
  });

  it('forgets one whose close found it gone, so the next batch opens its own', () => {
    const state = stateOf(
      ordered('web-7', 7, 'acme/web'),
      applied('web-7', 'order.issue', 200),
      applied('web-7', 'release.order', 'gone'),
      ordered('web-7-2', 7, 'acme/web'),
    );
    assert.deepStrictEqual(claimOrderOf(state, 'web-7'), { issue: 200 });
    assert.deepStrictEqual(claimOrderOf(state, 'web-7-2'), {});
  });

  it('says when the batch found the earlier one gone, and takes the one it opened instead', () => {
    const found = stateOf(
      ordered('web-7', 7, 'acme/web'),
      applied('web-7', 'order.issue', 200),
      ordered('web-7-2', 7, 'acme/web'),
      applied('web-7-2', 'order.reopen', 'gone'),
    );
    assert.deepStrictEqual(claimOrderOf(found, 'web-7-2'), {
      earlier: { issue: 200, gone: true },
    });
    const replaced = fold(
      [applied('web-7-2', 'order.issue', 201), ordered('web-7-3', 7, 'acme/web')],
      found,
    );
    assert.deepStrictEqual(claimOrderOf(replaced, 'web-7-2'), {
      earlier: { issue: 200, gone: true },
      issue: 201,
    });
    assert.deepStrictEqual(claimOrderOf(replaced, 'web-7-3'), {
      earlier: { issue: 201 },
      issue: 201,
    });
    assert.equal(claimOfOrder(replaced, 201)?.id, 'web-7-3');
    assert.equal(claimOfOrder(replaced, 200)?.id, 'web-7');
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

  for (const result of ['200', 0, -1, 1.5, 2 ** 53, null]) {
    it(`ignores a recorded result that is no positive integer: ${String(result)}`, () => {
      const state = stateOf(
        ordered('web-7', 7, 'acme/web'),
        applied('web-7', 'order.issue', result),
      );
      assert.deepStrictEqual(claimOrderOf(state, 'web-7'), {});
    });
  }

  it('takes the smallest issue number there is', () => {
    const state = stateOf(ordered('web-7', 7, 'acme/web'), applied('web-7', 'order.issue', 1));
    assert.deepStrictEqual(claimOrderOf(state, 'web-7'), { issue: 1 });
  });
});

describe('claimOfOrder', () => {
  it('finds the latest claimed batch whose order is the Brewery issue', () => {
    const state = stateOf(
      ordered('web-7', 7, 'acme/web'),
      applied('web-7', 'order.issue', 200),
      ordered('web-7-2', 7, 'Acme/Web'),
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
    ordered('web-7-2', 7, 'acme/web'),
    // An id targetBatchId never makes, as a test or an older log may hold.
    ordered('claimed', 4, 'acme/app'),
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

  it('names a batch ordered again by the alias its id starts with', () => {
    assert.equal(name('web-7-2'), '#200 (web#7)');
  });

  it('names a claimed issue owner/name#<n> when its batch id has no alias', () => {
    assert.equal(name('claimed'), 'acme/app#4');
  });
});
