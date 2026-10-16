import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import type { EventStore } from '../../src/engine/event-store.ts';
import { expireOwnLeases } from '../../src/engine/leases.ts';
import { openSqliteEventStore } from '../../src/engine/sqlite-event-store.ts';

const now = new Date('2026-10-15T12:00:00.000Z');
const later = new Date('2026-10-15T12:05:00.000Z');
const earlier = new Date('2026-10-15T11:59:00.000Z');
const key = (attempt: number): string => JSON.stringify(['1-1', 'plan', attempt]);

describe('expireOwnLeases', () => {
  let store: EventStore;
  beforeEach(() => {
    store = openSqliteEventStore(':memory:');
  });
  afterEach(() => store.close());

  it("expires the owner's live leases now and leaves other owners' alone", () => {
    store.withTransaction((tx) => {
      tx.putLease({ attemptKey: key(1), owner: 'cellar', expiresAt: later });
      tx.putLease({ attemptKey: key(2), owner: 'session-7', expiresAt: later });
    });
    assert.deepStrictEqual(expireOwnLeases(store, 'cellar', now), [key(1)]);
    assert.deepStrictEqual(store.currentLeases(now), [
      { attemptKey: key(2), owner: 'session-7', expiresAt: later },
    ]);
    assert.deepStrictEqual(store.expiredLeases(now), [
      { attemptKey: key(1), owner: 'cellar', expiresAt: now },
    ]);
  });

  it('leaves a lease that already expired as it is', () => {
    store.withTransaction((tx) => {
      tx.putLease({ attemptKey: key(1), owner: 'cellar', expiresAt: earlier });
    });
    assert.deepStrictEqual(expireOwnLeases(store, 'cellar', now), []);
    assert.deepStrictEqual(store.expiredLeases(now), [
      { attemptKey: key(1), owner: 'cellar', expiresAt: earlier },
    ]);
  });
});
