// An exclusive lock between processes on one machine (ADR 0037): a SQLite database in exclusive
// locking mode keeps the lock of its first write until it is closed, and the file lock under it
// (fcntl, LockFileEx) dies with the process: no stale lock to detect, and no pid that a new process
// may reuse.
//
// On macOS and Linux the lock is an fcntl lock, which belongs to the process, not to the file
// handle: closing any handle to the file drops every lock the process holds on it. So nothing may
// open a lock file except takeFileLock; another open and close in the same process, even a read,
// would free the lock while it is held.

import { DatabaseSync } from 'node:sqlite';

/**
 * A held lock. Keep this object for as long as the lock is held: the lock lives in the SQLite
 * database it holds, and garbage collection of that database would close it and free the lock.
 */
export interface FileLock {
  /** Releases the lock; call it once. */
  release(): void;
}

// SQLite's result code when another connection holds a lock it needs.
const SQLITE_BUSY = 5;

/**
 * Takes the exclusive lock of `path`, waiting up to `waitMs` (blocking) for a holder to let go;
 * `undefined` when another connection, in this process or another, still holds it.
 */
export const takeFileLock = (path: string, waitMs: number): FileLock | undefined => {
  const db = new DatabaseSync(path, { timeout: waitMs });
  try {
    db.exec('PRAGMA locking_mode = EXCLUSIVE');
    db.exec('BEGIN EXCLUSIVE');
    // The write that takes the exclusive lock for good.
    db.exec('CREATE TABLE IF NOT EXISTS taken (id INTEGER PRIMARY KEY)');
    db.exec('INSERT OR REPLACE INTO taken (id) VALUES (1)');
    db.exec('COMMIT');
  } catch (error) {
    db.close();
    if ((error as { errcode?: unknown }).errcode === SQLITE_BUSY) return undefined;
    throw error;
  }
  return { release: () => db.close() };
};
