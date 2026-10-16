// One driver per batch (ADR 0019): a batch lease is taken when free, renewed by its holder, refused
// to another driver while alive, and free again once expired.

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { holdBatch, releaseBatch } from '../../src/engine/batch-leases.ts';
import type { EventStore } from '../../src/engine/event-store.ts';
import { openSqliteEventStore } from '../../src/engine/sqlite-event-store.ts';

const t0 = new Date('2026-10-15T12:00:00.000Z');
const at = (minutes: number): Date => new Date(t0.getTime() + minutes * 60_000);
const leaseMs = 5 * 60_000;

describe('batch leases', () => {
  let store: EventStore;
  beforeEach(() => {
    store = openSqliteEventStore(':memory:');
  });
  afterEach(() => store.close());

  const hold = (owner: string, now: Date, batchId = 'b1') =>
    store.withTransaction((tx) => holdBatch(tx, { batchId, owner, now, leaseMs }));
  const release = (owner: string, batchId = 'b1') =>
    store.withTransaction((tx) => releaseBatch(tx, batchId, owner));

  it('takes a free batch until the lease runs out', () => {
    const lease = { batchId: 'b1', owner: 'cellar', expiresAt: at(5) };
    assert.deepStrictEqual(hold('cellar', t0), { kind: 'held', lease });
    assert.deepStrictEqual(store.batchLeases(t0), [lease]);
  });

  it('renews the lease its owner holds', () => {
    hold('cellar', t0);
    const lease = { batchId: 'b1', owner: 'cellar', expiresAt: at(9) };
    assert.deepStrictEqual(hold('cellar', at(4)), { kind: 'held', lease });
    assert.deepStrictEqual(store.batchLeases(at(6)), [lease]);
  });

  it("refuses a batch another driver's live lease holds, and leaves that lease", () => {
    hold('session-7', t0);
    const lease = { batchId: 'b1', owner: 'session-7', expiresAt: at(5) };
    assert.deepStrictEqual(hold('cellar', at(4)), { kind: 'other', lease });
    assert.deepStrictEqual(store.batchLeases(at(4)), [lease]);
  });

  it('takes a batch whose lease expired: an expired lease frees it', () => {
    hold('session-7', t0);
    const lease = { batchId: 'b1', owner: 'cellar', expiresAt: at(10) };
    // Alive while its expiry is ahead: at the expiry itself it is gone.
    assert.deepStrictEqual(hold('cellar', at(5)), { kind: 'held', lease });
    assert.deepStrictEqual(store.batchLeases(at(5)), [lease]);
  });

  it('holds each batch on its own', () => {
    hold('session-7', t0, 'b1');
    assert.equal(hold('cellar', t0, 'b2').kind, 'held');
    assert.deepStrictEqual(
      store.batchLeases(t0).map(({ batchId, owner }) => [batchId, owner]),
      [
        ['b1', 'session-7'],
        ['b2', 'cellar'],
      ],
    );
  });

  it('releases the lease its owner holds, and never another driver’s', () => {
    hold('session-7', t0, 'b1');
    hold('cellar', t0, 'b2');
    release('cellar', 'b1');
    release('cellar', 'b2');
    assert.deepStrictEqual(
      store.batchLeases(t0).map(({ batchId }) => batchId),
      ['b1'],
    );
    // Released, the batch is free at once.
    assert.equal(hold('session-7', t0, 'b2').kind, 'held');
  });

  it('releases nothing when the batch has no lease', () => {
    release('cellar', 'b9');
    assert.deepStrictEqual(store.batchLeases(t0), []);
  });
});
