// The EventStore on the built-in `node:sqlite` (ADR 0002). The only module that imports it.

import {
  DatabaseSync,
  type DatabaseSyncOptions,
  type SQLInputValue,
  type StatementSync,
} from 'node:sqlite';
import { Event } from '../schemas/events.ts';
import { effectKey } from './effect-key.ts';
import {
  DuplicateEffectError,
  type EffectKey,
  type EventStore,
  type EventStoreTransaction,
  InvalidLogError,
  type Lease,
} from './event-store.ts';

export interface SqliteEventStoreOptions {
  /** How long a write waits for another connection's lock before failing; default 5000 ms. */
  busyTimeoutMs?: number;
  /** Opens the connection; defaults to `new DatabaseSync`. Tests inject one to inspect it. */
  openDatabase?: (path: string, options: DatabaseSyncOptions) => DatabaseSync;
}

// Migration n brings the database from schema version n to n + 1 (`PRAGMA user_version`).
// Times are stored as epoch milliseconds, so they compare as times whatever their ISO precision.
// `deadlines` and `effects` are indexes of the events, maintained on append (and so by `replay`).
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

  -- The pending deadline of each step of a batch; step_id '' holds a Conditioning reminder.
  CREATE TABLE deadlines (
    batch_id TEXT NOT NULL,
    step_id TEXT NOT NULL,
    attempt INTEGER NOT NULL,
    deadline_at INTEGER NOT NULL,
    PRIMARY KEY (batch_id, step_id)
  ) STRICT;
  CREATE INDEX deadlines_by_time ON deadlines (deadline_at);

  CREATE TABLE leases (
    attempt_key TEXT PRIMARY KEY,
    owner TEXT NOT NULL,
    expires_at INTEGER NOT NULL
  ) STRICT;
  CREATE INDEX leases_by_expiry ON leases (expires_at);

  -- The idempotency ledger (invariant I4) is the effect.applied events; this is their UNIQUE index.
  CREATE TABLE effects (
    key TEXT NOT NULL UNIQUE,
    event_id INTEGER NOT NULL
  ) STRICT;
  CREATE TRIGGER effects_no_update BEFORE UPDATE ON effects
    BEGIN SELECT RAISE(ABORT, 'effects are append-only'); END;
  CREATE TRIGGER effects_no_delete BEFORE DELETE ON effects
    BEGIN SELECT RAISE(ABORT, 'effects are append-only'); END;
  -- The database, not a code path, keeps the index (ADR 0002): a duplicate key fails the INSERT
  -- of its event, which leaves no row behind.
  CREATE TRIGGER events_index_effects AFTER INSERT ON events WHEN NEW.type = 'effect.applied'
    BEGIN INSERT INTO effects (key, event_id) VALUES (json_extract(NEW.body, '$.key'), NEW.id); END;
  `,
];

// node:sqlite reports the extended result code in `errcode` (ADR 0002 verification).
const SQLITE_CONSTRAINT_UNIQUE = 2067;
// The deadlines row of a Conditioning reminder; step ids are never empty.
const REMINDER = '';

const timeOf = (date: Date, name: string): number => {
  const time = date.getTime();
  if (!Number.isFinite(time)) throw new RangeError(`${name} must be a valid date`);
  return time;
};

const rows = <T>(statement: StatementSync, ...params: SQLInputValue[]): T[] =>
  statement.all(...params) as T[];

const isThenable = (value: unknown): value is PromiseLike<unknown> =>
  typeof (value as { then?: unknown } | null)?.then === 'function';

// A body that is not JSON fails the schema like any other invalid event.
const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

const parseStored = (id: number, body: string): Event => {
  const parsed = Event.safeParse(parseJson(body));
  if (!parsed.success) throw new Error(`Stored event ${id} is invalid: ${parsed.error}`);
  return parsed.data;
};

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
      if (db.isTransaction) db.exec('ROLLBACK');
      throw error;
    }
  }
};

/** Opens (and creates or migrates) the store at `path`; `':memory:'` for a private in-memory one. */
export const openSqliteEventStore = (
  path: string,
  options: SqliteEventStoreOptions = {},
): EventStore => {
  const {
    busyTimeoutMs = 5000,
    openDatabase = (file, settings) => new DatabaseSync(file, settings),
  } = options;
  const db = openDatabase(path, { timeout: busyTimeoutMs });
  try {
    db.exec('PRAGMA journal_mode = WAL');
    migrate(db);
  } catch (error) {
    db.close();
    throw error;
  }

  const insertEvent = db.prepare('INSERT INTO events (type, body) VALUES (?, ?)');
  const setDeadline = db.prepare(
    'INSERT INTO deadlines (batch_id, step_id, attempt, deadline_at) VALUES (?, ?, ?, ?) ' +
      'ON CONFLICT (batch_id, step_id) DO UPDATE ' +
      'SET attempt = excluded.attempt, deadline_at = excluded.deadline_at',
  );
  const clearDeadline = db.prepare(
    'DELETE FROM deadlines WHERE batch_id = ? AND step_id = ? AND attempt = ?',
  );
  const clearDeadlines = db.prepare('DELETE FROM deadlines WHERE batch_id = ?');
  const putLease = db.prepare(
    'INSERT INTO leases (attempt_key, owner, expires_at) VALUES (?, ?, ?) ' +
      'ON CONFLICT (attempt_key) DO UPDATE SET owner = excluded.owner, expires_at = excluded.expires_at',
  );
  const releaseLease = db.prepare('DELETE FROM leases WHERE attempt_key = ?');
  const selectEvents = db.prepare('SELECT id, body FROM events WHERE id > ? ORDER BY id LIMIT ?');
  const selectAnyEvent = db.prepare('SELECT 1 FROM events LIMIT 1');
  // The earliest due deadline of a batch is its earliest pending deadline.
  const selectDue = db.prepare(
    'SELECT batch_id, MIN(deadline_at) AS deadline_at FROM deadlines WHERE deadline_at <= ? ' +
      'GROUP BY batch_id ORDER BY deadline_at, batch_id',
  );
  const selectLeases = db.prepare(
    'SELECT attempt_key, owner, expires_at FROM leases WHERE expires_at > ? ' +
      'ORDER BY expires_at, attempt_key',
  );
  const selectEffect = db.prepare(
    'SELECT events.id, events.body FROM effects JOIN events ON events.id = effects.event_id ' +
      'WHERE effects.key = ?',
  );

  /** Keeps the deadlines index up to date with an appended event. */
  const index = (event: Event): void => {
    switch (event.type) {
      case 'step.scheduled':
        // Scheduling a step ends Conditioning, and replaces the step's earlier attempt.
        clearDeadline.run(event.batchId, REMINDER, 0);
        setDeadline.run(event.batchId, event.stepId, event.attempt, Date.parse(event.deadlineAt));
        return;
      case 'batch.waiting':
        setDeadline.run(event.batchId, REMINDER, 0, Date.parse(event.remindAt));
        return;
      case 'step.finished':
        clearDeadline.run(event.batchId, event.stepId, event.attempt);
        return;
      case 'batch.stuck':
      case 'batch.on_tap':
      case 'batch.cancelled':
        clearDeadlines.run(event.batchId);
        return;
      case 'effect.applied': // indexed by the events_index_effects trigger
      case 'batch.ordered':
      case 'batch.recipe_chosen':
      case 'step.started':
      case 'input.received':
      case 'batch.resumed':
      case 'order.decomposed':
      case 'bottle.opened':
      case 'release.observed':
      case 'batch.rewound':
        return;
      default: {
        const unhandled: never = event;
        throw new Error(`Unhandled event ${JSON.stringify(unhandled)}`);
      }
    }
  };

  const append = (event: Event, key?: EffectKey): number => {
    const valid = Event.parse(event);
    const applied =
      valid.type === 'effect.applied' ? (key ?? effectKey.decode(valid.key)) : undefined;
    let id: number;
    try {
      id = Number(insertEvent.run(valid.type, JSON.stringify(valid)).lastInsertRowid);
    } catch (error) {
      if (applied && (error as { errcode?: unknown }).errcode === SQLITE_CONSTRAINT_UNIQUE) {
        throw new DuplicateEffectError(applied);
      }
      throw error;
    }
    index(valid);
    return id;
  };

  const transaction = (): { tx: EventStoreTransaction; end: () => void } => {
    let live = true;
    const ensureLive = () => {
      if (!live) throw new Error('The transaction has ended');
    };
    const tx: EventStoreTransaction = {
      append: (event) => {
        ensureLive();
        return append(event);
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
        append({ type: 'effect.applied', key: effectKey.encode(key), result: result ?? null }, key);
      },
    };
    return {
      tx,
      end: () => {
        live = false;
      },
    };
  };

  const withTransaction = <T>(fn: (tx: EventStoreTransaction) => T): T => {
    if (db.isTransaction) throw new Error('withTransaction cannot be nested');
    db.exec('BEGIN IMMEDIATE');
    const { tx, end } = transaction();
    try {
      const result = fn(tx);
      if (isThenable(result)) {
        // Its later writes fail on the ended transaction; the caller already gets this error.
        result.then(undefined, () => {});
        throw new TypeError('The withTransaction callback must be synchronous');
      }
      db.exec('COMMIT');
      return result;
    } catch (error) {
      if (db.isTransaction) db.exec('ROLLBACK');
      throw error;
    } finally {
      end();
    }
  };

  return {
    withTransaction,

    eventsAfter: (afterId, limit = -1) =>
      rows<{ id: number; body: string }>(selectEvents, afterId, limit).map(({ id, body }) => ({
        id,
        event: parseStored(id, body),
      })),

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

    replay: (log) =>
      withTransaction(() => {
        if (selectAnyEvent.get() !== undefined) throw new Error('replay needs an empty store');
        log.forEach((event, i) => {
          try {
            append(event as Event);
          } catch (error) {
            throw new InvalidLogError(i, error);
          }
        });
      }),

    findEffect: (key) => {
      const row = selectEffect.get(effectKey.encode(key)) as
        | { id: number; body: string }
        | undefined;
      if (row === undefined) return undefined;
      const event = parseStored(row.id, row.body);
      if (event.type !== 'effect.applied') {
        throw new Error(`Stored event ${row.id} is indexed as an effect but is ${event.type}`);
      }
      return { result: event.result };
    },

    close: () => db.close(),
  };
};
