import assert from 'node:assert/strict';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { isDeepStrictEqual } from 'node:util';
import {
  DuplicateEffectError,
  type EffectKey,
  type EventStore,
  ReplayError,
} from '../../src/engine/event-store.ts';
import {
  openSqliteEventStore,
  type SqliteEventStoreOptions,
} from '../../src/engine/sqlite-event-store.ts';
import type { Event } from '../../src/schemas/events.ts';
import { z } from '../../src/schemas/zod.ts';
import { makeTempDir, type TempDir } from '../helpers/temp-dir.ts';

const ordered = (batchId: string): Event => ({
  type: 'batch.ordered',
  batchId,
  order: { issue: 6 },
});
const scheduled = (batchId: string, deadlineAt: string, attempt = 1, stepId = 'plan'): Event => ({
  type: 'step.scheduled',
  batchId,
  stepId,
  attempt,
  deadlineAt,
});
const finishedStep = (batchId: string, stepId: string, attempt: number): Event => ({
  type: 'step.finished',
  batchId,
  stepId,
  attempt,
  outcome: { kind: 'cancelled' },
});
const stuck = (batchId: string, remindAt = '2026-10-17T11:00:00Z'): Event => ({
  type: 'batch.stuck',
  batchId,
  reason: { kind: 'deadline_passed', stepId: 'plan', deadlineAt: '2026-10-15T11:00:00Z' },
  options: ['retry'],
  remindAt,
});
const waiting = (batchId: string, remindAt: string): Event => ({
  type: 'batch.waiting',
  batchId,
  on: { kind: 'sibling', batchId: 'other' },
  remindAt,
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
const open = (path: string, options?: SqliteEventStoreOptions): EventStore => {
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

      assert.deepEqual(
        store.eventsAfter(0).map((stored) => stored.event),
        [applied('first')],
      );
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

    it('indexes an appended effect.applied event like a recorded effect', () => {
      store.withTransaction((tx) => tx.append(applied('appended')));
      assert.deepEqual(store.findEffect(key), { result: 'appended' });
      assert.throws(
        () => store.withTransaction((tx) => tx.recordEffect(key, 'again')),
        (error) => error instanceof DuplicateEffectError && error.key === key,
      );
      assert.throws(
        () => store.withTransaction((tx) => tx.append(applied('again'))),
        (error) => error instanceof DuplicateEffectError && isDeepStrictEqual(error.key, key),
      );
      assert.equal(store.eventsAfter(0).length, 1);
    });

    it('writes nothing for a rejected duplicate effect, even when the caller catches it', () => {
      const tolerate = (write: () => void) => {
        try {
          write();
        } catch (error) {
          if (!(error instanceof DuplicateEffectError)) throw error;
        }
      };
      store.withTransaction((tx) => tx.recordEffect(key, 'first'));
      store.withTransaction((tx) => {
        tolerate(() => tx.recordEffect(key, 'second'));
        tolerate(() => tx.append(applied('third')));
        tx.append(ordered('b1'));
      });

      assert.deepEqual(
        store.eventsAfter(0).map((stored) => stored.event),
        [applied('first'), ordered('b1')],
      );
      assert.deepEqual(store.findEffect(key), { result: 'first' });
    });

    it('rejects an effect.applied event whose key is not a canonical effect key', () => {
      for (const text of ['open-pr', '["b1", "open-pr", 1, "pull_request"]']) {
        assert.throws(
          () =>
            store.withTransaction((tx) =>
              tx.append({ type: 'effect.applied', key: text, result: 1 }),
            ),
          /Must be a canonical effect key/,
        );
      }
      assert.deepEqual(store.eventsAfter(0), []);
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

    it('leaves no unhandled rejection behind when it rejects an asynchronous callback', async () => {
      const rejections: unknown[] = [];
      const onRejection = (reason: unknown) => rejections.push(reason);
      process.on('unhandledRejection', onRejection);
      try {
        assert.throws(
          () =>
            store.withTransaction(async (tx) => {
              await null;
              tx.append(ordered('b1'));
            }),
          /must be synchronous/,
        );
        await new Promise((resolve) => setImmediate(resolve));
      } finally {
        process.off('unhandledRejection', onRejection);
      }
      assert.deepEqual(rejections, []);
      assert.deepEqual(store.eventsAfter(0), []);
    });

    it('accepts a new transaction after a rollback', () => {
      const failure = new Error('first fails');
      assert.throws(
        () =>
          store.withTransaction(() => {
            throw failure;
          }),
        (error) => error === failure,
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

    it('lists the leases that expired at or before now, earliest first', () => {
      const later = {
        attemptKey: 'b2/plan#1',
        owner: 'session',
        expiresAt: at('2026-10-15T10:02:00Z'),
      };
      store.withTransaction((tx) => {
        tx.putLease(later);
        tx.putLease(lease);
      });

      assert.deepEqual(store.expiredLeases(at('2026-10-15T10:00:00Z')), []);
      assert.deepEqual(store.expiredLeases(at('2026-10-15T10:01:00Z')), [lease]);
      assert.deepEqual(store.expiredLeases(at('2026-10-15T10:05:00Z')), [lease, later]);
    });

    it('no longer lists an expired lease once it is released', () => {
      store.withTransaction((tx) => tx.putLease(lease));
      store.withTransaction((tx) => tx.releaseLease(lease.attemptKey));
      assert.deepEqual(store.expiredLeases(at('2026-10-15T10:05:00Z')), []);
    });

    it('refuses an invalid now for expired leases', () => {
      assert.throws(() => store.expiredLeases(new Date(Number.NaN)), /now must be a valid date/);
    });

    it('renews a lease in place and releases it', () => {
      const renewed = { ...lease, expiresAt: at('2026-10-15T10:05:00Z') };
      store.withTransaction((tx) => tx.putLease(lease));
      store.withTransaction((tx) => tx.putLease(renewed));
      assert.deepEqual(store.currentLeases(at('2026-10-15T10:03:00Z')), [renewed]);

      store.withTransaction((tx) => tx.releaseLease(lease.attemptKey));
      assert.deepEqual(store.currentLeases(at('2026-10-15T10:00:00Z')), []);
    });

    for (const field of ['owner', 'attemptKey'] as const) {
      it(`rejects a lease with an empty ${field} and stores nothing`, () => {
        assert.throws(
          () => store.withTransaction((tx) => tx.putLease({ ...lease, [field]: '' })),
          new RegExp(field),
        );
        assert.deepEqual(store.currentLeases(at('2026-10-15T10:00:00Z')), []);
      });
    }

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
      ['batch.stuck', stuck],
      [
        'batch.on_tap',
        (batchId) => ({
          type: 'batch.on_tap',
          batchId,
          pullRequests: ['https://github.com/o/r/pull/1'],
        }),
      ],
      [
        'batch.cancelled',
        (batchId) => ({ type: 'batch.cancelled', batchId, by: 'octocat', via: 'plugin' }),
      ],
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

    const leavingAlone: [string, Event][] = [
      ['batch.ordered', ordered('b1')],
      [
        'batch.recipe_chosen',
        { type: 'batch.recipe_chosen', batchId: 'b1', recipe: 'r', reason: 'x', source: 'label' },
      ],
      ['step.started', started('b1')],
      [
        'input.received',
        {
          type: 'input.received',
          batchId: 'b1',
          stepId: 'plan',
          by: 'octocat',
          via: 'comment',
          answers: [{ q: 'q', answer: 'a' }],
        },
      ],
      [
        'batch.resumed',
        { type: 'batch.resumed', batchId: 'b1', by: 'octocat', via: 'terminal', action: 'retry' },
      ],
      [
        'order.decomposed',
        {
          type: 'order.decomposed',
          batchId: 'b1',
          subOrders: [{ issue: 7, repo: 'o/r' }],
          dependencies: [],
        },
      ],
      [
        'batch.rewound',
        {
          type: 'batch.rewound',
          batchId: 'b1',
          toStepId: 'plan',
          by: 'octocat',
          via: 'plugin',
          shas: {},
        },
      ],
      [
        'bottle.opened',
        {
          type: 'bottle.opened',
          bottleId: 'b1',
          repo: 'o/r',
          subOrders: [7],
          pullRequest: 'https://github.com/o/r/pull/1',
        },
      ],
      [
        'release.observed',
        { type: 'release.observed', repo: 'o/r', package: 'b1', version: '1.0.0' },
      ],
      ['effect.applied', applied('r')],
    ];
    for (const [type, event] of leavingAlone) {
      it(`keeps the deadline of a batch on ${type}`, () => {
        store.withTransaction((tx) => {
          tx.append(scheduled('b1', '2026-10-15T11:00:00Z'));
          tx.append(event);
        });
        assert.deepEqual(store.batchesPastDeadline(now), [
          { batchId: 'b1', deadlineAt: at('2026-10-15T11:00:00Z') },
        ]);
      });
    }

    it('keeps the deadline of each step of a batch until that step finishes', () => {
      store.withTransaction((tx) => {
        tx.append(scheduled('b1', '2026-10-15T11:00:00Z', 1, 'correctness'));
        tx.append(scheduled('b1', '2026-10-15T11:30:00Z', 1, 'security'));
        tx.append(finishedStep('b1', 'correctness', 1));
      });
      assert.deepEqual(store.batchesPastDeadline(now), [
        { batchId: 'b1', deadlineAt: at('2026-10-15T11:30:00Z') },
      ]);
    });

    it('reports the earliest pending deadline of a batch once', () => {
      store.withTransaction((tx) => {
        tx.append(scheduled('b1', '2026-10-15T11:00:00Z', 1, 'correctness'));
        tx.append(scheduled('b1', '2026-10-15T11:30:00Z', 1, 'security'));
      });
      assert.deepEqual(store.batchesPastDeadline(now), [
        { batchId: 'b1', deadlineAt: at('2026-10-15T11:00:00Z') },
      ]);
    });

    it('keeps the deadline of a new attempt when an earlier attempt finishes late', () => {
      store.withTransaction((tx) => {
        tx.append(scheduled('b1', '2026-10-15T11:00:00Z', 1));
        tx.append(scheduled('b1', '2026-10-15T11:30:00Z', 2));
        tx.append(finishedStep('b1', 'plan', 1));
      });
      assert.deepEqual(store.batchesPastDeadline(now), [
        { batchId: 'b1', deadlineAt: at('2026-10-15T11:30:00Z') },
      ]);
    });

    it('clears the deadlines of every step of a batch when it gets stuck', () => {
      store.withTransaction((tx) => {
        tx.append(scheduled('b1', '2026-10-15T11:00:00Z', 1, 'correctness'));
        tx.append(scheduled('b1', '2026-10-15T11:30:00Z', 1, 'security'));
        tx.append(waiting('b1', '2026-10-15T11:45:00Z'));
        tx.append(stuck('b1'));
      });
      assert.deepEqual(store.batchesPastDeadline(now), []);
    });

    it('takes the reminder of a Stuck batch as its deadline (ADR 0025)', () => {
      store.withTransaction((tx) => {
        tx.append(scheduled('b1', '2026-10-15T11:00:00Z'));
        tx.append(stuck('b1', '2026-10-15T11:30:00Z'));
      });
      assert.deepEqual(store.batchesPastDeadline(now), [
        { batchId: 'b1', deadlineAt: at('2026-10-15T11:30:00Z') },
      ]);
    });

    it('ends the Stuck reminder when a step is scheduled', () => {
      store.withTransaction((tx) => {
        tx.append(stuck('b1', '2026-10-15T11:00:00Z'));
        tx.append(scheduled('b1', '2026-10-15T13:00:00Z', 2));
      });
      assert.deepEqual(store.batchesPastDeadline(now), []);
    });

    it('replaces the Stuck reminder of a batch', () => {
      store.withTransaction((tx) => {
        tx.append(stuck('b1', '2026-10-15T11:00:00Z'));
        tx.append(stuck('b1', '2026-10-15T13:00:00Z'));
      });
      assert.deepEqual(store.batchesPastDeadline(now), []);
      assert.deepEqual(store.batchesPastDeadline(at('2026-10-15T14:00:00Z')), [
        { batchId: 'b1', deadlineAt: at('2026-10-15T13:00:00Z') },
      ]);
    });

    it('ends the Conditioning reminder when a step is scheduled', () => {
      store.withTransaction((tx) => {
        tx.append(waiting('b1', '2026-10-15T11:00:00Z'));
        tx.append(scheduled('b1', '2026-10-15T13:00:00Z'));
      });
      assert.deepEqual(store.batchesPastDeadline(now), []);
    });

    it('replaces the Conditioning reminder of a batch', () => {
      store.withTransaction((tx) => {
        tx.append(waiting('b1', '2026-10-15T11:00:00Z'));
        tx.append(waiting('b1', '2026-10-15T13:00:00Z'));
      });
      assert.deepEqual(store.batchesPastDeadline(now), []);
    });

    it('sets no deadline for a rolled-back schedule', () => {
      const failure = new Error('rollback');
      assert.throws(
        () =>
          store.withTransaction((tx) => {
            tx.append(scheduled('b1', '2026-10-15T11:00:00Z'));
            throw failure;
          }),
        (error) => error === failure,
      );
      assert.deepEqual(store.batchesPastDeadline(now), []);
    });

    it('rejects an invalid now', () => {
      assert.throws(() => store.batchesPastDeadline(new Date('x')), /now/);
      assert.throws(() => store.currentLeases(new Date('x')), /now/);
    });
  });

  describe('replay', () => {
    const now = at('2026-10-15T12:00:00Z');

    it('rebuilds the events, the deadlines and the effects index from a log', () => {
      const log = [ordered('b1'), scheduled('b1', '2026-10-15T11:00:00Z'), applied('r')];
      store.replay(log);
      assert.deepEqual(
        store.eventsAfter(0).map((stored) => stored.event),
        log,
      );
      assert.deepEqual(store.batchesPastDeadline(now), [
        { batchId: 'b1', deadlineAt: at('2026-10-15T11:00:00Z') },
      ]);
      assert.deepEqual(store.findEffect(key), { result: 'r' });
    });

    it('rejects a log with two effect.applied events for one key, naming the second', () => {
      const log = [ordered('b1'), applied('first'), ordered('b2'), applied('second')];
      assert.throws(
        () => store.replay(log),
        (error) =>
          error instanceof ReplayError &&
          error.index === 3 &&
          error.cause instanceof DuplicateEffectError &&
          /Event 3 of the log/.test(error.message),
      );
      assert.deepEqual(store.eventsAfter(0), []);
      assert.equal(store.findEffect(key), undefined);
    });

    it('rejects a log with an invalid event, naming it', () => {
      assert.throws(
        () => store.replay([ordered('b1'), { type: 'batch.ordered', batchId: 'b2' }]),
        (error) => error instanceof ReplayError && error.index === 1,
      );
      assert.deepEqual(store.eventsAfter(0), []);
    });

    it('refuses to replay into a store that already has events', () => {
      store.withTransaction((tx) => tx.append(ordered('b1')));
      assert.throws(() => store.replay([ordered('b2')]), /empty store/);
      assert.equal(store.eventsAfter(0).length, 1);
    });
  });

  it('finds no effect that was never recorded', () => {
    assert.equal(store.findEffect(key), undefined);
  });

  // The state branch's outbox (ADR 0024).
  const commit = 'c'.repeat(40);
  const later = 'd'.repeat(64);
  const appendAll = (events: Event[]): void =>
    store.withTransaction((tx) => {
      for (const event of events) tx.append(event);
    });

  describe('lastEventId', () => {
    it('is 0 for an empty store', () => {
      assert.equal(store.lastEventId(), 0);
    });

    it('is the id of the last committed event', () => {
      appendAll([ordered('b1'), ordered('b2')]);
      assert.throws(() =>
        store.withTransaction((tx) => {
          tx.append(ordered('b3'));
          throw new Error('roll back');
        }),
      );
      assert.equal(store.lastEventId(), 2);
    });
  });

  describe('the pushed-through marker', () => {
    it('is undefined until something was pushed', () => {
      appendAll([ordered('b1')]);
      assert.equal(store.pushedThrough(), undefined);
    });

    it('records the last pushed event and its commit, and moves forward', () => {
      appendAll([ordered('b1'), ordered('b2'), ordered('b3')]);
      store.withTransaction((tx) => tx.markPushed({ eventId: 2, commit }));
      assert.deepEqual(store.pushedThrough(), { eventId: 2, commit });
      store.withTransaction((tx) => tx.markPushed({ eventId: 3, commit: later }));
      assert.deepEqual(store.pushedThrough(), { eventId: 3, commit: later });
    });

    it('accepts event 0 on an empty store: a branch without events', () => {
      store.withTransaction((tx) => tx.markPushed({ eventId: 0, commit }));
      assert.deepEqual(store.pushedThrough(), { eventId: 0, commit });
    });

    it('keeps the event id and changes the commit for a push without new events', () => {
      appendAll([ordered('b1')]);
      store.withTransaction((tx) => tx.markPushed({ eventId: 1, commit }));
      store.withTransaction((tx) => tx.markPushed({ eventId: 1, commit: later }));
      assert.deepEqual(store.pushedThrough(), { eventId: 1, commit: later });
    });

    it('rolls back with its transaction', () => {
      appendAll([ordered('b1')]);
      assert.throws(() =>
        store.withTransaction((tx) => {
          tx.markPushed({ eventId: 1, commit });
          throw new Error('roll back');
        }),
      );
      assert.equal(store.pushedThrough(), undefined);
    });

    it('refuses to move back', () => {
      appendAll([ordered('b1'), ordered('b2')]);
      store.withTransaction((tx) => tx.markPushed({ eventId: 2, commit }));
      assert.throws(
        () => store.withTransaction((tx) => tx.markPushed({ eventId: 1, commit: later })),
        /back/,
      );
      assert.deepEqual(store.pushedThrough(), { eventId: 2, commit });
    });

    it('refuses an event the store does not have', () => {
      appendAll([ordered('b1')]);
      assert.throws(
        () => store.withTransaction((tx) => tx.markPushed({ eventId: 2, commit })),
        /last event/,
      );
      assert.equal(store.pushedThrough(), undefined);
    });

    const invalid: [string, unknown][] = [
      ['an abbreviated commit', { eventId: 1, commit: 'abc1234' }],
      ['a negative event id', { eventId: -1, commit }],
      ['a fractional event id', { eventId: 0.5, commit }],
      ['an unknown field', { eventId: 1, commit, branch: 'foedrum/state' }],
    ];
    for (const [what, marker] of invalid) {
      it(`refuses ${what}`, () => {
        appendAll([ordered('b1')]);
        // The schema refuses it, not SQLite's column types.
        assert.throws(
          () =>
            store.withTransaction((tx) =>
              tx.markPushed(marker as { eventId: number; commit: string }),
            ),
          z.ZodError,
        );
        assert.equal(store.pushedThrough(), undefined);
      });
    }
  });

  describe('restore', () => {
    const now = at('2026-10-15T12:00:00Z');

    it('appends the events with their ids and marks them pushed', () => {
      const log = [
        { id: 3, event: ordered('b1') },
        { id: 7, event: scheduled('b1', '2026-10-15T11:00:00Z') },
        { id: 8, event: applied('r') },
      ];
      store.restore(log, commit);
      assert.deepEqual(store.eventsAfter(0), log);
      assert.deepEqual(store.pushedThrough(), { eventId: 8, commit });
      assert.deepEqual(store.batchesPastDeadline(now), [
        { batchId: 'b1', deadlineAt: at('2026-10-15T11:00:00Z') },
      ]);
      assert.deepEqual(store.findEffect(key), { result: 'r' });
    });

    it('continues a store whose events are all pushed, and later appends follow', () => {
      appendAll([ordered('b1'), ordered('b2')]);
      store.withTransaction((tx) => tx.markPushed({ eventId: 2, commit }));
      store.restore([{ id: 5, event: ordered('b3') }], later);
      const appended = store.withTransaction((tx) => tx.append(ordered('b4')));
      assert.equal(appended, 6);
      assert.deepEqual(
        store.eventsAfter(0).map((stored) => stored.id),
        [1, 2, 5, 6],
      );
      assert.deepEqual(store.pushedThrough(), { eventId: 5, commit: later });
    });

    it('moves only the commit for an empty log', () => {
      appendAll([ordered('b1')]);
      store.withTransaction((tx) => tx.markPushed({ eventId: 1, commit }));
      store.restore([], later);
      assert.deepEqual(store.pushedThrough(), { eventId: 1, commit: later });
      store.close();
      store = open(':memory:');
      store.restore([], commit);
      assert.deepEqual(store.pushedThrough(), { eventId: 0, commit });
    });

    const refused: [string, { id: number; event: unknown }[], number][] = [
      [
        'a repeated id',
        [
          { id: 2, event: ordered('b1') },
          { id: 2, event: ordered('b2') },
        ],
        1,
      ],
      [
        'a smaller id',
        [
          { id: 4, event: ordered('b1') },
          { id: 3, event: ordered('b2') },
        ],
        1,
      ],
      ['id 0', [{ id: 0, event: ordered('b1') }], 0],
      ['a fractional id', [{ id: 1.5, event: ordered('b1') }], 0],
      [
        'an invalid event',
        [
          { id: 1, event: ordered('b1') },
          { id: 2, event: { type: 'x' } },
        ],
        1,
      ],
      [
        'a second effect for one key',
        [
          { id: 1, event: applied('first') },
          { id: 2, event: applied('second') },
        ],
        1,
      ],
    ];
    for (const [what, log, index] of refused) {
      it(`refuses ${what}, naming the event, and writes nothing`, () => {
        assert.throws(
          () => store.restore(log, commit),
          (error) => error instanceof ReplayError && error.index === index,
        );
        assert.deepEqual(store.eventsAfter(0), []);
        assert.equal(store.pushedThrough(), undefined);
      });
    }

    it('refuses an id that does not come after the stored events', () => {
      appendAll([ordered('b1'), ordered('b2')]);
      store.withTransaction((tx) => tx.markPushed({ eventId: 2, commit }));
      assert.throws(
        () => store.restore([{ id: 2, event: ordered('b3') }], later),
        (error) => error instanceof ReplayError && error.index === 0,
      );
      assert.equal(store.lastEventId(), 2);
      assert.deepEqual(store.pushedThrough(), { eventId: 2, commit });
    });

    it('refuses a store with events that were never pushed', () => {
      appendAll([ordered('b1'), ordered('b2')]);
      store.withTransaction((tx) => tx.markPushed({ eventId: 1, commit }));
      assert.throws(() => store.restore([{ id: 5, event: ordered('b3') }], later), /not pushed/);
      assert.equal(store.lastEventId(), 2);
    });

    it('refuses an invalid commit and writes nothing', () => {
      assert.throws(() => store.restore([{ id: 1, event: ordered('b1') }], 'abc1234'), z.ZodError);
      assert.equal(store.lastEventId(), 0);
    });
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

  it('uses WAL mode and records schema version 2', () => {
    open(path);
    const db = raw(path);
    assert.deepEqual({ ...db.prepare('PRAGMA journal_mode').get() }, { journal_mode: 'wal' });
    assert.deepEqual({ ...db.prepare('PRAGMA user_version').get() }, { user_version: 2 });
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

  it('upgrades a schema version 1 database and keeps its events', () => {
    const first = open(path);
    first.withTransaction((tx) => tx.append(ordered('b1')));
    first.close();
    // What version 1 left: no pushed table.
    const db = raw(path);
    db.exec('DROP TABLE pushed; PRAGMA user_version = 1');
    db.close();

    const upgraded = open(path);
    assert.deepEqual(
      upgraded.eventsAfter(0).map((stored) => stored.event),
      [ordered('b1')],
    );
    assert.equal(upgraded.pushedThrough(), undefined);
    upgraded.withTransaction((tx) => tx.markPushed({ eventId: 1, commit: 'e'.repeat(40) }));
    assert.deepEqual(upgraded.pushedThrough(), { eventId: 1, commit: 'e'.repeat(40) });
    assert.deepEqual({ ...raw(path).prepare('PRAGMA user_version').get() }, { user_version: 2 });
  });

  it('keeps the pushed-through marker across a reopen', () => {
    const first = open(path);
    first.restore([{ id: 4, event: ordered('b1') }], 'e'.repeat(40));
    first.close();
    const second = open(path);
    assert.equal(second.lastEventId(), 4);
    assert.deepEqual(second.pushedThrough(), { eventId: 4, commit: 'e'.repeat(40) });
  });

  it('refuses a database written by a newer schema version', () => {
    const db = raw(path);
    db.exec('PRAGMA user_version = 3');
    db.close();
    assert.throws(() => open(path), /schema version 3/);
    // The refused connection is closed: on Windows an open file could not be removed.
    rmSync(path);
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

  it('lets the database refuse a second effect.applied event for a key', () => {
    open(path).withTransaction((tx) => tx.recordEffect(key, 'r'));
    const body = JSON.stringify(applied('again'));
    assert.throws(
      () =>
        raw(path).prepare("INSERT INTO events (type, body) VALUES ('effect.applied', ?)").run(body),
      /UNIQUE constraint failed: effects\.key/,
    );
  });

  it('rejects a stored event that fails the schema when reading it', () => {
    const store = open(path);
    store.withTransaction((tx) => tx.append(ordered('b1')));
    raw(path).exec(
      `INSERT INTO events (type, body) VALUES ('batch.ordered', '{"type":"batch.ordered"}')`,
    );
    assert.throws(() => store.eventsAfter(0), /event 2/);
  });

  it('rejects a stored event that is not JSON when reading it', () => {
    const store = open(path);
    store.withTransaction((tx) => tx.append(ordered('b1')));
    raw(path).exec(`INSERT INTO events (type, body) VALUES ('batch.ordered', 'not json')`);
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

  for (const [what, options, expected] of [
    ['5000 ms by default', {}, 5000],
    ['the configured value', { busyTimeoutMs: 250 }, 250],
  ] as const) {
    it(`sets the connection's busy timeout to ${what}`, () => {
      let connection: DatabaseSync | undefined;
      open(path, {
        ...options,
        openDatabase: (file, databaseOptions) => {
          connection = new DatabaseSync(file, databaseOptions);
          return connection;
        },
      });
      assert.ok(connection, 'the store opened its connection through openDatabase');
      assert.deepEqual(
        { ...connection.prepare('PRAGMA busy_timeout').get() },
        { timeout: expected },
      );
    });
  }

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

describe('SqliteEventStore read-only', () => {
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

  const version = (): unknown => ({ ...raw(path).prepare('PRAGMA user_version').get() });

  it('refuses to append', () => {
    open(path).withTransaction((tx) => tx.append(ordered('b1')));
    closeAll();
    const reader = open(path, { readOnly: true });
    assert.throws(() => reader.withTransaction((tx) => tx.append(ordered('b2'))), /readonly/i);
    assert.equal(reader.lastEventId(), 1);
  });

  it('refuses an older schema version without migrating it', () => {
    open(path).withTransaction((tx) => tx.append(ordered('b1')));
    closeAll();
    const db = raw(path);
    db.exec('DROP TABLE pushed; PRAGMA user_version = 1');
    db.close();
    assert.throws(() => open(path, { readOnly: true }), /schema version 1/);
    assert.deepEqual(version(), { user_version: 1 });
  });

  it('leaves the journal mode as it is', () => {
    open(path);
    closeAll();
    const db = raw(path);
    db.exec('PRAGMA journal_mode = DELETE');
    db.close();
    open(path, { readOnly: true });
    assert.deepEqual(
      { ...raw(path).prepare('PRAGMA journal_mode').get() },
      { journal_mode: 'delete' },
    );
  });

  it('creates no database where there is none', () => {
    assert.throws(() => open(path, { readOnly: true }));
    assert.equal(existsSync(path), false);
  });
});
