// The EventStore on the built-in `node:sqlite` (ADR 0002). The only module that imports it.

import {
  DatabaseSync,
  type DatabaseSyncOptions,
  type SQLInputValue,
  type StatementSync,
} from 'node:sqlite';
import { Event } from '../schemas/events.ts';
import { Lease, PushedThrough } from '../schemas/store.ts';
import { effectKey } from './effect-key.ts';
import {
  DuplicateEffectError,
  type EffectKey,
  type EventStore,
  type EventStoreTransaction,
  ReplayError,
} from './event-store.ts';

export interface SqliteEventStoreOptions {
  /** How long a write waits for another connection's lock before failing; default 5000 ms. */
  busyTimeoutMs?: number;
  /**
   * Opens an existing store for reading only (ADR 0030): no journal mode change, no migration, and
   * every write fails. A store at another schema version is refused.
   */
  readOnly?: boolean;
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
  `
  -- How far the state branch has the log (ADR 0024): one row once something was pushed.
  CREATE TABLE pushed (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    event_id INTEGER NOT NULL,
    commit_sha TEXT NOT NULL
  ) STRICT;
  `,
];

// node:sqlite reports the extended result code in `errcode` (ADR 0002 verification).
const SQLITE_CONSTRAINT_UNIQUE = 2067;
// The deadlines row of a batch rather than a step: its routing deadline while Ordered, or its
// Conditioning or Stuck reminder (ADR 0032). Step ids are never empty.
const BATCH = '';

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
    readOnly = false,
    openDatabase = (file, settings) => new DatabaseSync(file, settings),
  } = options;
  const db = openDatabase(path, { timeout: busyTimeoutMs, readOnly });
  try {
    if (readOnly) {
      // A reader changes nothing: a store at another version is for a Foedrum that knows it.
      const { user_version: version } = db.prepare('PRAGMA user_version').get() as {
        user_version: number;
      };
      if (version !== migrations.length) {
        throw new Error(
          `The event store has schema version ${version}; this Foedrum reads version ${migrations.length} only`,
        );
      }
    } else {
      db.exec('PRAGMA journal_mode = WAL');
      migrate(db);
    }
  } catch (error) {
    db.close();
    throw error;
  }

  const insertEvent = db.prepare('INSERT INTO events (type, body) VALUES (?, ?)');
  // An id from the state branch; AUTOINCREMENT continues after it.
  const insertEventWithId = db.prepare('INSERT INTO events (id, type, body) VALUES (?, ?, ?)');
  const selectLastId = db.prepare('SELECT COALESCE(MAX(id), 0) AS id FROM events');
  const selectPushed = db.prepare('SELECT event_id, commit_sha FROM pushed');
  const putPushed = db.prepare(
    'INSERT INTO pushed (singleton, event_id, commit_sha) VALUES (1, ?, ?) ' +
      'ON CONFLICT (singleton) DO UPDATE SET event_id = excluded.event_id, commit_sha = excluded.commit_sha',
  );
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
  const selectExpiredLeases = db.prepare(
    'SELECT attempt_key, owner, expires_at FROM leases WHERE expires_at <= ? ' +
      'ORDER BY expires_at, attempt_key',
  );
  const leasesFrom = (statement: StatementSync, now: Date): Lease[] =>
    rows<{ attempt_key: string; owner: string; expires_at: number }>(
      statement,
      timeOf(now, 'now'),
    ).map((row) => ({
      attemptKey: row.attempt_key,
      owner: row.owner,
      expiresAt: new Date(row.expires_at),
    }));
  const selectEffect = db.prepare(
    'SELECT events.id, events.body FROM effects JOIN events ON events.id = effects.event_id ' +
      'WHERE effects.key = ?',
  );

  /** Keeps the deadlines index up to date with an appended event. */
  const index = (event: Event): void => {
    switch (event.type) {
      case 'step.scheduled':
        // Scheduling a step ends a routing deadline or a Conditioning or Stuck reminder, and
        // replaces the step's earlier attempt.
        clearDeadline.run(event.batchId, BATCH, 0);
        setDeadline.run(event.batchId, event.stepId, event.attempt, Date.parse(event.deadlineAt));
        return;
      case 'batch.ordered':
        setDeadline.run(event.batchId, BATCH, 0, Date.parse(event.routeBy));
        return;
      case 'batch.waiting':
        setDeadline.run(event.batchId, BATCH, 0, Date.parse(event.remindAt));
        return;
      case 'batch.resumed':
        // A retry of a batch Stuck on routing: Ordered again, with a new routing deadline (ADR 0032).
        if (event.routeBy !== undefined) {
          setDeadline.run(event.batchId, BATCH, 0, Date.parse(event.routeBy));
        }
        return;
      case 'step.finished':
        clearDeadline.run(event.batchId, event.stepId, event.attempt);
        return;
      case 'batch.stuck':
        // A Stuck batch waits for a human: its reminder replaces its steps' deadlines (ADR 0025).
        clearDeadlines.run(event.batchId);
        setDeadline.run(event.batchId, BATCH, 0, Date.parse(event.remindAt));
        return;
      case 'batch.on_tap':
      case 'batch.cancelled':
        clearDeadlines.run(event.batchId);
        return;
      case 'effect.applied': // indexed by the events_index_effects trigger
      case 'batch.recipe_chosen':
      case 'step.started':
      case 'input.received':
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

  /** Appends `event`, with the given id when it comes from the state branch. */
  const append = (event: Event, key?: EffectKey, withId?: number): number => {
    const valid = Event.parse(event);
    const applied =
      valid.type === 'effect.applied' ? (key ?? effectKey.decode(valid.key)) : undefined;
    let id: number;
    try {
      const body = JSON.stringify(valid);
      const result =
        withId === undefined
          ? insertEvent.run(valid.type, body)
          : insertEventWithId.run(withId, valid.type, body);
      id = Number(result.lastInsertRowid);
    } catch (error) {
      if (applied && (error as { errcode?: unknown }).errcode === SQLITE_CONSTRAINT_UNIQUE) {
        throw new DuplicateEffectError(applied);
      }
      throw error;
    }
    index(valid);
    return id;
  };

  const lastEventId = (): number => (selectLastId.get() as { id: number }).id;

  const pushedThrough = (): PushedThrough | undefined => {
    const row = selectPushed.get() as { event_id: number; commit_sha: string } | undefined;
    return row === undefined ? undefined : { eventId: row.event_id, commit: row.commit_sha };
  };

  const markPushed = (marker: PushedThrough): void => {
    const { eventId, commit } = PushedThrough.parse(marker);
    const current = pushedThrough();
    if (current !== undefined && eventId < current.eventId) {
      throw new Error(
        `The pushed-through marker cannot move back from ${current.eventId} to ${eventId}`,
      );
    }
    const last = lastEventId();
    if (eventId > last) {
      throw new Error(`Event ${eventId} cannot be pushed: the last event is ${last}`);
    }
    putPushed.run(eventId, commit);
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
        // The date first, so an invalid expiry gets the store's own message.
        const expiresAt = timeOf(lease.expiresAt, 'Lease expiresAt');
        const valid = Lease.parse(lease);
        putLease.run(valid.attemptKey, valid.owner, expiresAt);
      },
      releaseLease: (attemptKey) => {
        ensureLive();
        releaseLease.run(attemptKey);
      },
      recordEffect: (key, result) => {
        ensureLive();
        append({ type: 'effect.applied', key: effectKey.encode(key), result: result ?? null }, key);
      },
      markPushed: (marker) => {
        ensureLive();
        markPushed(marker);
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

    currentLeases: (now) => leasesFrom(selectLeases, now),

    expiredLeases: (now) => leasesFrom(selectExpiredLeases, now),

    replay: (log) =>
      withTransaction(() => {
        if (selectAnyEvent.get() !== undefined) throw new Error('replay needs an empty store');
        log.forEach((event, i) => {
          try {
            append(event as Event);
          } catch (error) {
            throw new ReplayError(i, error);
          }
        });
      }),

    lastEventId,

    pushedThrough,

    restore: (log, commit) =>
      withTransaction(() => {
        let previous = lastEventId();
        const pushed = pushedThrough()?.eventId ?? 0;
        if (previous > pushed) {
          throw new Error(
            `restore needs every stored event pushed; events after ${pushed} are not pushed`,
          );
        }
        log.forEach(({ id, event }, i) => {
          try {
            if (!Number.isSafeInteger(id) || id <= previous) {
              throw new Error(`id ${id} must be an integer greater than ${previous}`);
            }
            append(event as Event, undefined, id);
          } catch (error) {
            throw new ReplayError(i, error);
          }
          previous = id;
        });
        markPushed({ eventId: previous, commit });
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
