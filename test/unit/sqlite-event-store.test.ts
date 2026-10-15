import assert from 'node:assert/strict';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, it } from 'node:test';
import {
  DuplicateEffectError,
  type EffectKey,
  type EventStore,
} from '../../src/engine/event-store.ts';
import { openSqliteEventStore } from '../../src/engine/sqlite-event-store.ts';
import type { Event } from '../../src/schemas/events.ts';
import { makeTempDir, type TempDir } from '../helpers/temp-dir.ts';

const ordered = (batchId: string): Event => ({
  type: 'batch.ordered',
  batchId,
  order: { issue: 6 },
});
const scheduled = (batchId: string, deadlineAt: string, attempt = 1): Event => ({
  type: 'step.scheduled',
  batchId,
  stepId: 'plan',
  attempt,
  deadlineAt,
});
const started = (batchId: string): Event => ({
  type: 'step.started',
  batchId,
  stepId: 'plan',
  attempt: 1,
});
const finished = (batchId: string): Event => ({
  type: 'step.finished',
  batchId,
  stepId: 'plan',
  attempt: 1,
  outcome: { kind: 'cancelled' },
});

const key: EffectKey = { batchId: 'b1', stepId: 'open-pr', attempt: 1, effect: 'pull_request' };
// The event recordEffect appends for `key`: the event log is the idempotency ledger.
const applied = (result: unknown): Event => ({
  type: 'effect.applied',
  key: '["b1","open-pr",1,"pull_request"]',
  result,
});
const lease = {
  attemptKey: 'b1/plan#1',
  owner: 'cellar',
  expiresAt: new Date('2026-10-15T10:01:00Z'),
};
const at = (iso: string): Date => new Date(iso);

// Every store a test opens, closed afterwards so its files can be removed (Windows keeps them open).
const opened: (EventStore | DatabaseSync)[] = [];
const open = (path: string, options?: { busyTimeoutMs?: number }): EventStore => {
  const store = openSqliteEventStore(path, options);
  opened.push(store);
  return store;
};
const raw = (path: string): DatabaseSync => {
  const db = new DatabaseSync(path);
  opened.push(db);
  return db;
};
const closeAll = () => {
  for (const handle of opened.splice(0)) {
    try {
      handle.close();
    } catch {
      // already closed by the test
    }
  }
};

describe('SqliteEventStore in memory', () => {
  let store: EventStore;
  beforeEach(() => {
    store = open(':memory:');
  });
  afterEach(closeAll);

  describe('append and eventsAfter', () => {
    it('returns committed events after an id, oldest first, with growing ids', () => {
      const ids = store.withTransaction((tx) => [
        tx.append(ordered('b1')),
        tx.append(ordered('b2')),
        tx.append(ordered('b3')),
      ]);
      assert.equal(ids.length, 3);
      assert.ok((ids[0] as number) < (ids[1] as number) && (ids[1] as number) < (ids[2] as number));

      assert.deepEqual(store.eventsAfter(0), [
        { id: ids[0], event: ordered('b1') },
        { id: ids[1], event: ordered('b2') },
        { id: ids[2], event: ordered('b3') },
      ]);
      assert.deepEqual(
        store.eventsAfter(ids[0] as number).map((stored) => stored.id),
        [ids[1], ids[2]],
      );
      assert.deepEqual(store.eventsAfter(ids[2] as number), []);
    });

    it('returns at most limit events', () => {
      store.withTransaction((tx) => {
        for (const id of ['b1', 'b2', 'b3']) tx.append(ordered(id));
      });
      assert.deepEqual(
        store.eventsAfter(0, 2).map((stored) => stored.event),
        [ordered('b1'), ordered('b2')],
      );
    });

    it('rejects an event that fails the schema and keeps nothing of the transaction', () => {
      const invalid = { type: 'batch.ordered', batchId: 'b2', order: { issue: -1 } } as Event;
      assert.throws(
        () =>
          store.withTransaction((tx) => {
            tx.append(ordered('b1'));
            tx.append(invalid);
          }),
        { name: 'ZodError' },
      );
      assert.deepEqual(store.eventsAfter(0), []);
    });
  });

  describe('withTransaction', () => {
    it('commits an append, a lease and an effect together', () => {
      const result = store.withTransaction((tx) => {
        tx.append(ordered('b1'));
        tx.putLease(lease);
        tx.recordEffect(key, { pullRequest: 'https://github.com/o/r/pull/1' });
        return 'done';
      });

      assert.equal(result, 'done');
      assert.deepEqual(
        store.eventsAfter(0).map((stored) => stored.event),
        [ordered('b1'), applied({ pullRequest: 'https://github.com/o/r/pull/1' })],
      );
      assert.deepEqual(store.currentLeases(at('2026-10-15T10:00:00Z')), [lease]);
      assert.deepEqual(store.findEffect(key), {
        result: { pullRequest: 'https://github.com/o/r/pull/1' },
      });
    });

    it('rolls back the append, the lease and the effect when the callback throws', () => {
      const failure = new Error('crash after the writes');
      assert.throws(
        () =>
          store.withTransaction((tx) => {
            tx.append(ordered('b1'));
            tx.putLease(lease);
            tx.recordEffect(key, 'result');
            throw failure;
          }),
        (error) => error === failure,
      );

      assert.deepEqual(store.eventsAfter(0), []);
      assert.deepEqual(store.currentLeases(at('2026-10-15T10:00:00Z')), []);
      assert.equal(store.findEffect(key), undefined);
    });

    it('rejects a duplicate effect and undoes the other writes of its transaction', () => {
      store.withTransaction((tx) => tx.recordEffect(key, 'first'));

      assert.throws(
        () =>
          store.withTransaction((tx) => {
            tx.append(ordered('b1'));
            tx.putLease(lease);
            tx.recordEffect(key, 'second');
          }),
        (error) => error instanceof DuplicateEffectError && error.key === key,
      );

      assert.deepEqual(store.eventsAfter(0), []);
      assert.deepEqual(store.currentLeases(at('2026-10-15T10:00:00Z')), []);
      assert.deepEqual(store.findEffect(key), { result: 'first' });
    });

    it('treats effects that differ in any part of the key as different effects', () => {
      const others: EffectKey[] = [
        { ...key, batchId: 'b2' },
        { ...key, stepId: 'other' },
        { ...key, attempt: 2 },
        { ...key, effect: 'comment' },
      ];
      store.withTransaction((tx) => {
        tx.recordEffect(key, 0);
        others.forEach((other, i) => {
          tx.recordEffect(other, i + 1);
        });
      });
      assert.deepEqual(
        [key, ...others].map((k) => store.findEffect(k)),
        [0, 1, 2, 3, 4].map((result) => ({ result })),
      );
    });

    it('records an effect without a result as null', () => {
      store.withTransaction((tx) => tx.recordEffect(key, undefined));
      assert.deepEqual(store.findEffect(key), { result: null });
    });

    it('rejects a nested transaction and rolls back the outer one', () => {
      assert.throws(
        () =>
          store.withTransaction((tx) => {
            tx.append(ordered('b1'));
            store.withTransaction((inner) => inner.append(ordered('b2')));
          }),
        /cannot be nested/,
      );
      assert.deepEqual(store.eventsAfter(0), []);
    });

    it('rejects an asynchronous callback and rolls back what it wrote', () => {
      assert.throws(
        () =>
          store.withTransaction(async (tx) => {
            tx.append(ordered('b1'));
          }),
        /must be synchronous/,
      );
      assert.deepEqual(store.eventsAfter(0), []);
    });

    it('refuses writes through a transaction that has ended', () => {
      let kept: Parameters<Parameters<EventStore['withTransaction']>[0]>[0] | undefined;
      store.withTransaction((tx) => {
        kept = tx;
      });
      assert.throws(() => kept?.append(ordered('b1')), /transaction has ended/);
      assert.throws(() => kept?.putLease(lease), /transaction has ended/);
      assert.throws(() => kept?.releaseLease(lease.attemptKey), /transaction has ended/);
      assert.throws(() => kept?.recordEffect(key, 1), /transaction has ended/);
      assert.deepEqual(store.eventsAfter(0), []);
    });

    it('accepts a new transaction after a rollback', () => {
      assert.throws(() =>
        store.withTransaction(() => {
          throw new Error('first fails');
        }),
      );
      store.withTransaction((tx) => tx.append(ordered('b1')));
      assert.equal(store.eventsAfter(0).length, 1);
    });
  });

  describe('leases', () => {
    it('lists only leases still alive at now', () => {
      const other = {
        attemptKey: 'b2/plan#1',
        owner: 'session',
        expiresAt: at('2026-10-15T10:02:00Z'),
      };
      store.withTransaction((tx) => {
        tx.putLease(lease);
        tx.putLease(other);
      });

      assert.deepEqual(store.currentLeases(at('2026-10-15T10:00:00Z')), [lease, other]);
      assert.deepEqual(store.currentLeases(at('2026-10-15T10:01:00Z')), [other]);
      assert.deepEqual(store.currentLeases(at('2026-10-15T10:02:00Z')), []);
    });

    it('renews a lease in place and releases it', () => {
      const renewed = { ...lease, expiresAt: at('2026-10-15T10:05:00Z') };
      store.withTransaction((tx) => tx.putLease(lease));
      store.withTransaction((tx) => tx.putLease(renewed));
      assert.deepEqual(store.currentLeases(at('2026-10-15T10:03:00Z')), [renewed]);

      store.withTransaction((tx) => tx.releaseLease(lease.attemptKey));
      assert.deepEqual(store.currentLeases(at('2026-10-15T10:00:00Z')), []);
    });

    it('rejects a lease with an invalid expiry', () => {
      assert.throws(
        () => store.withTransaction((tx) => tx.putLease({ ...lease, expiresAt: new Date('x') })),
        /expiresAt/,
      );
    });
  });

  describe('batchesPastDeadline', () => {
    const now = at('2026-10-15T12:00:00Z');

    it('lists batches whose scheduled deadline is at or before now, earliest first', () => {
      store.withTransaction((tx) => {
        tx.append(ordered('late'));
        tx.append(scheduled('late', '2026-10-15T11:00:00Z'));
        tx.append(scheduled('due-now', '2026-10-15T12:00:00Z'));
        tx.append(scheduled('earliest', '2026-10-15T09:00:00Z'));
        tx.append(scheduled('future', '2026-10-15T12:00:01Z'));
      });
      assert.deepEqual(store.batchesPastDeadline(now), [
        { batchId: 'earliest', deadlineAt: at('2026-10-15T09:00:00Z') },
        { batchId: 'late', deadlineAt: at('2026-10-15T11:00:00Z') },
        { batchId: 'due-now', deadlineAt: now },
      ]);
    });

    it('compares deadlines as times, whatever their precision', () => {
      store.withTransaction((tx) => {
        tx.append(scheduled('fraction', '2026-10-15T12:00:00.5Z'));
        tx.append(scheduled('whole', '2026-10-15T11:59:59Z'));
      });
      assert.deepEqual(store.batchesPastDeadline(now), [
        { batchId: 'whole', deadlineAt: at('2026-10-15T11:59:59Z') },
      ]);
    });

    it('uses the latest deadline of a batch and keeps it while the step runs', () => {
      store.withTransaction((tx) => {
        tx.append(scheduled('b1', '2026-10-15T11:00:00Z'));
        tx.append(scheduled('b1', '2026-10-15T13:00:00Z', 2));
        tx.append(scheduled('b2', '2026-10-15T11:00:00Z'));
        tx.append(started('b2'));
      });
      assert.deepEqual(store.batchesPastDeadline(now), [
        { batchId: 'b2', deadlineAt: at('2026-10-15T11:00:00Z') },
      ]);
    });

    it('takes the reminder of a Conditioning batch as its deadline', () => {
      store.withTransaction((tx) => {
        tx.append(scheduled('b1', '2026-10-15T13:00:00Z'));
        tx.append({
          type: 'batch.waiting',
          batchId: 'b1',
          on: { kind: 'sibling', batchId: 'b2' },
          remindAt: '2026-10-15T11:30:00Z',
        });
      });
      assert.deepEqual(store.batchesPastDeadline(now), [
        { batchId: 'b1', deadlineAt: at('2026-10-15T11:30:00Z') },
      ]);
    });

    const settling: [string, (batchId: string) => Event][] = [
      ['step.finished', finished],
      [
        'batch.stuck',
        (batchId) => ({
          type: 'batch.stuck',
          batchId,
          reason: { kind: 'deadline_passed', stepId: 'plan', deadlineAt: '2026-10-15T11:00:00Z' },
          options: ['retry'],
        }),
      ],
      [
        'batch.on_tap',
        (batchId) => ({
          type: 'batch.on_tap',
          batchId,
          pullRequests: ['https://github.com/o/r/pull/1'],
        }),
      ],
      ['batch.cancelled', (batchId) => ({ type: 'batch.cancelled', batchId, by: 'edwin' })],
    ];
    for (const [type, event] of settling) {
      it(`clears the deadline of a batch on ${type}`, () => {
        store.withTransaction((tx) => {
          tx.append(scheduled('b1', '2026-10-15T11:00:00Z'));
          tx.append(scheduled('b2', '2026-10-15T11:00:00Z'));
          tx.append(event('b1'));
        });
        assert.deepEqual(
          store.batchesPastDeadline(now).map((due) => due.batchId),
          ['b2'],
        );
      });
    }

    it('sets no deadline for a rolled-back schedule', () => {
      assert.throws(() =>
        store.withTransaction((tx) => {
          tx.append(scheduled('b1', '2026-10-15T11:00:00Z'));
          throw new Error('rollback');
        }),
      );
      assert.deepEqual(store.batchesPastDeadline(now), []);
    });
  });

  it('finds no effect that was never recorded', () => {
    assert.equal(store.findEffect(key), undefined);
  });
});

describe('SqliteEventStore on a file', () => {
  let dir: TempDir;
  let path: string;
  beforeEach(() => {
    dir = makeTempDir('event-store');
    path = join(dir.path, 'foedrum.db');
  });
  afterEach(() => {
    closeAll();
    dir.remove();
  });

  it('uses WAL mode and records schema version 1', () => {
    open(path);
    const db = raw(path);
    assert.deepEqual({ ...db.prepare('PRAGMA journal_mode').get() }, { journal_mode: 'wal' });
    assert.deepEqual({ ...db.prepare('PRAGMA user_version').get() }, { user_version: 1 });
  });

  it('keeps events, leases and effects across a reopen', () => {
    const first = open(path);
    first.withTransaction((tx) => {
      tx.append(ordered('b1'));
      tx.putLease(lease);
      tx.recordEffect(key, 'r');
    });
    first.close();

    const second = open(path);
    assert.deepEqual(
      second.eventsAfter(0).map((stored) => stored.event),
      [ordered('b1'), applied('r')],
    );
    assert.deepEqual(second.currentLeases(at('2026-10-15T10:00:00Z')), [lease]);
    assert.deepEqual(second.findEffect(key), { result: 'r' });
  });

  it('refuses a database written by a newer schema version', () => {
    raw(path).exec('PRAGMA user_version = 2');
    assert.throws(() => open(path), /schema version 2/);
  });

  it('refuses to change or delete stored events and effects', () => {
    open(path).withTransaction((tx) => {
      tx.append(ordered('b1'));
      tx.recordEffect(key, 'r');
    });
    const db = raw(path);
    assert.throws(() => db.exec("UPDATE events SET body = '{}'"), /append-only/);
    assert.throws(() => db.exec('DELETE FROM events'), /append-only/);
    assert.throws(() => db.exec("UPDATE effects SET key = 'x'"), /append-only/);
    assert.throws(() => db.exec('DELETE FROM effects'), /append-only/);
  });

  it('rejects a stored event that fails the schema when reading it', () => {
    const store = open(path);
    store.withTransaction((tx) => tx.append(ordered('b1')));
    raw(path).exec(
      `INSERT INTO events (type, body) VALUES ('batch.ordered', '{"type":"batch.ordered"}')`,
    );
    assert.throws(() => store.eventsAfter(0), /event 2/);
  });

  it('lets a reader see the last committed state while a write transaction is open', () => {
    const writer = open(path);
    const reader = open(path);
    writer.withTransaction((tx) => {
      tx.append(ordered('b1'));
      tx.putLease(lease);
    });

    writer.withTransaction((tx) => {
      tx.append(ordered('b2'));
      tx.releaseLease(lease.attemptKey);
      tx.recordEffect(key, 'r');

      assert.deepEqual(
        reader.eventsAfter(0).map((stored) => stored.event),
        [ordered('b1')],
      );
      assert.deepEqual(reader.currentLeases(at('2026-10-15T10:00:00Z')), [lease]);
      assert.equal(reader.findEffect(key), undefined);
    });

    assert.deepEqual(
      reader.eventsAfter(0).map((stored) => stored.event),
      [ordered('b1'), ordered('b2'), applied('r')],
    );
    assert.deepEqual(reader.currentLeases(at('2026-10-15T10:00:00Z')), []);
    assert.deepEqual(reader.findEffect(key), { result: 'r' });
  });

  it('waits the busy timeout for another writer, then fails', () => {
    const writer = open(path);
    const waiting = open(path, { busyTimeoutMs: 100 });
    writer.withTransaction(() => {
      const started = performance.now();
      assert.throws(
        () => waiting.withTransaction((tx) => tx.append(ordered('b1'))),
        /database is locked/,
      );
      assert.ok(performance.now() - started >= 90, 'waited for the lock');
    });
    waiting.withTransaction((tx) => tx.append(ordered('b1')));
    assert.equal(writer.eventsAfter(0).length, 1);
  });
});
