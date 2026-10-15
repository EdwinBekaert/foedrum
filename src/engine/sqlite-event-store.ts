// The EventStore on the built-in `node:sqlite` (ADR 0002). The only module that imports it.

import { DatabaseSync, type SQLInputValue, type StatementSync } from 'node:sqlite';
import { Event } from '../schemas/events.ts';
import {
  DuplicateEffectError,
  type EffectKey,
  type EventStore,
  type EventStoreTransaction,
  type Lease,
} from './event-store.ts';

export interface SqliteEventStoreOptions {
  /** How long a write waits for another connection's lock before failing; default 5000 ms. */
  busyTimeoutMs?: number;
}

// Migration n brings the database from schema version n to n + 1 (`PRAGMA user_version`).
// Times are stored as epoch milliseconds, so they compare as times whatever their ISO precision.
const migrations = [
  `
  CREATE TABLE events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL,
    body TEXT NOT NULL
  ) STRICT;
  CREATE TRIGGER events_no_update BEFORE UPDATE ON events
    BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;
  CREATE TRIGGER events_no_delete BEFORE DELETE ON events
    BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;

  -- Index of each batch's pending deadline, maintained on append; rebuilt by replaying the events.
  CREATE TABLE deadlines (
    batch_id TEXT PRIMARY KEY,
    deadline_at INTEGER NOT NULL
  ) STRICT;
  CREATE INDEX deadlines_by_time ON deadlines (deadline_at);

  CREATE TABLE leases (
    attempt_key TEXT PRIMARY KEY,
    owner TEXT NOT NULL,
    expires_at INTEGER NOT NULL
  ) STRICT;
  CREATE INDEX leases_by_expiry ON leases (expires_at);

  -- The idempotency ledger (invariant I4).
  CREATE TABLE effects (
    batch_id TEXT NOT NULL,
    step_id TEXT NOT NULL,
    attempt INTEGER NOT NULL,
    effect TEXT NOT NULL,
    result TEXT NOT NULL,
    UNIQUE (batch_id, step_id, attempt, effect)
  ) STRICT;
  CREATE TRIGGER effects_no_update BEFORE UPDATE ON effects
    BEGIN SELECT RAISE(ABORT, 'effects are append-only'); END;
  CREATE TRIGGER effects_no_delete BEFORE DELETE ON effects
    BEGIN SELECT RAISE(ABORT, 'effects are append-only'); END;
  `,
];

// node:sqlite reports the extended result code in `errcode` (ADR 0002 verification).
const SQLITE_CONSTRAINT_UNIQUE = 2067;

/** How an event changes its batch's pending deadline: set it, clear it, or leave it. */
const deadlineChange = (event: Event): { batchId: string; at: string | null } | undefined => {
  switch (event.type) {
    case 'step.scheduled':
      return { batchId: event.batchId, at: event.deadlineAt };
    case 'batch.waiting':
      return { batchId: event.batchId, at: event.remindAt };
    case 'step.finished':
    case 'batch.stuck':
    case 'batch.on_tap':
    case 'batch.cancelled':
      return { batchId: event.batchId, at: null };
    case 'batch.ordered':
    case 'batch.recipe_chosen':
    case 'step.started':
    case 'input.received':
    case 'batch.resumed':
    case 'order.decomposed':
    case 'bottle.opened':
    case 'release.observed':
    case 'batch.rewound':
    case 'effect.applied':
      return undefined;
    default: {
      const unhandled: never = event;
      throw new Error(`Unhandled event ${JSON.stringify(unhandled)}`);
    }
  }
};

const timeOf = (date: Date, name: string): number => {
  const time = date.getTime();
  if (!Number.isFinite(time)) throw new RangeError(`${name} must be a valid date`);
  return time;
};

const rows = <T>(statement: StatementSync, ...params: SQLInputValue[]): T[] =>
  statement.all(...params) as T[];

const isThenable = (value: unknown): boolean =>
  typeof (value as { then?: unknown } | null)?.then === 'function';

const migrate = (db: DatabaseSync): void => {
  const version = (): number =>
    (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
  if (version() > migrations.length) {
    throw new Error(
      `The event store has schema version ${version()}; this Foedrum knows up to ${migrations.length}`,
    );
  }
  while (version() < migrations.length) {
    db.exec('BEGIN IMMEDIATE');
    try {
      // Read again under the write lock: another connection may have migrated meanwhile.
      const from = version();
      if (from < migrations.length) {
        db.exec(migrations[from] as string);
        db.exec(`PRAGMA user_version = ${from + 1}`);
      }
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
};

/** Opens (and creates or migrates) the store at `path`; `':memory:'` for a private in-memory one. */
export const openSqliteEventStore = (
  path: string,
  options: SqliteEventStoreOptions = {},
): EventStore => {
  const db = new DatabaseSync(path, { timeout: options.busyTimeoutMs ?? 5000 });
  try {
    db.exec('PRAGMA journal_mode = WAL');
    migrate(db);
  } catch (error) {
    db.close();
    throw error;
  }

  const insertEvent = db.prepare('INSERT INTO events (type, body) VALUES (?, ?)');
  const setDeadline = db.prepare(
    'INSERT INTO deadlines (batch_id, deadline_at) VALUES (?, ?) ' +
      'ON CONFLICT (batch_id) DO UPDATE SET deadline_at = excluded.deadline_at',
  );
  const clearDeadline = db.prepare('DELETE FROM deadlines WHERE batch_id = ?');
  const putLease = db.prepare(
    'INSERT INTO leases (attempt_key, owner, expires_at) VALUES (?, ?, ?) ' +
      'ON CONFLICT (attempt_key) DO UPDATE SET owner = excluded.owner, expires_at = excluded.expires_at',
  );
  const releaseLease = db.prepare('DELETE FROM leases WHERE attempt_key = ?');
  const insertEffect = db.prepare(
    'INSERT INTO effects (batch_id, step_id, attempt, effect, result) VALUES (?, ?, ?, ?, ?)',
  );
  const selectEvents = db.prepare('SELECT id, body FROM events WHERE id > ? ORDER BY id LIMIT ?');
  const selectDue = db.prepare(
    'SELECT batch_id, deadline_at FROM deadlines WHERE deadline_at <= ? ' +
      'ORDER BY deadline_at, batch_id',
  );
  const selectLeases = db.prepare(
    'SELECT attempt_key, owner, expires_at FROM leases WHERE expires_at > ? ' +
      'ORDER BY expires_at, attempt_key',
  );
  const selectEffect = db.prepare(
    'SELECT result FROM effects WHERE batch_id = ? AND step_id = ? AND attempt = ? AND effect = ?',
  );

  let inTransaction = false;

  const transaction = (): { tx: EventStoreTransaction; end: () => void } => {
    let live = true;
    const ensureLive = () => {
      if (!live) throw new Error('The transaction has ended');
    };
    const tx: EventStoreTransaction = {
      append: (event) => {
        ensureLive();
        const valid = Event.parse(event);
        const { lastInsertRowid } = insertEvent.run(valid.type, JSON.stringify(valid));
        const change = deadlineChange(valid);
        if (change?.at === null) clearDeadline.run(change.batchId);
        else if (change) setDeadline.run(change.batchId, Date.parse(change.at));
        return Number(lastInsertRowid);
      },
      putLease: (lease) => {
        ensureLive();
        putLease.run(lease.attemptKey, lease.owner, timeOf(lease.expiresAt, 'Lease expiresAt'));
      },
      releaseLease: (attemptKey) => {
        ensureLive();
        releaseLease.run(attemptKey);
      },
      recordEffect: (key, result) => {
        ensureLive();
        try {
          insertEffect.run(
            key.batchId,
            key.stepId,
            key.attempt,
            key.effect,
            JSON.stringify(result) ?? 'null',
          );
        } catch (error) {
          if ((error as { errcode?: unknown }).errcode === SQLITE_CONSTRAINT_UNIQUE) {
            throw new DuplicateEffectError(key);
          }
          throw error;
        }
      },
    };
    return {
      tx,
      end: () => {
        live = false;
      },
    };
  };

  return {
    withTransaction: (fn) => {
      if (inTransaction) throw new Error('withTransaction cannot be nested');
      db.exec('BEGIN IMMEDIATE');
      inTransaction = true;
      const { tx, end } = transaction();
      try {
        const result = fn(tx);
        if (isThenable(result)) {
          throw new TypeError('The withTransaction callback must be synchronous');
        }
        db.exec('COMMIT');
        return result;
      } catch (error) {
        if (db.isTransaction) db.exec('ROLLBACK');
        throw error;
      } finally {
        end();
        inTransaction = false;
      }
    },

    eventsAfter: (afterId, limit = -1) =>
      rows<{ id: number; body: string }>(selectEvents, afterId, limit).map(({ id, body }) => {
        const parsed = Event.safeParse(parseJson(body));
        if (!parsed.success) throw new Error(`Stored event ${id} is invalid: ${parsed.error}`);
        return { id, event: parsed.data };
      }),

    batchesPastDeadline: (now) =>
      rows<{ batch_id: string; deadline_at: number }>(selectDue, timeOf(now, 'now')).map((row) => ({
        batchId: row.batch_id,
        deadlineAt: new Date(row.deadline_at),
      })),

    currentLeases: (now) =>
      rows<{ attempt_key: string; owner: string; expires_at: number }>(
        selectLeases,
        timeOf(now, 'now'),
      ).map(
        (row): Lease => ({
          attemptKey: row.attempt_key,
          owner: row.owner,
          expiresAt: new Date(row.expires_at),
        }),
      ),

    findEffect: (key: EffectKey) => {
      const row = selectEffect.get(key.batchId, key.stepId, key.attempt, key.effect) as
        | { result: string }
        | undefined;
      return row && { result: JSON.parse(row.result) as unknown };
    },

    close: () => db.close(),
  };
};

// A body that is not JSON fails the schema like any other invalid event.
const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};
