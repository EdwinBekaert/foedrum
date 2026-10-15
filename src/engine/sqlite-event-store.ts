// The EventStore on the built-in `node:sqlite` (ADR 0002). The only module that imports it.

import type { EventStore } from './event-store.ts';

export interface SqliteEventStoreOptions {
  /** How long a write waits for another connection's lock before failing; default 5000 ms. */
  busyTimeoutMs?: number;
}

/** Opens (and creates or migrates) the store at `path`; `':memory:'` for a private in-memory one. */
export const openSqliteEventStore = (
  _path: string,
  _options: SqliteEventStoreOptions = {},
): EventStore => {
  throw new Error('not implemented');
};
