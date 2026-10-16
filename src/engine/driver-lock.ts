// One Brewery per work root, and one process per driver (ADR 0037). The work root records the
// Brewery it belongs to, and every driver of that Brewery (the Cellar, each interactive session)
// holds a lock of its own there, which the operating system releases when its process dies.

import { linkSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { errorCode } from '../platform/remove.ts';
import { Repo } from '../schemas/events.ts';
import { PathSafeId } from '../schemas/ids.ts';
import { readJsonc } from '../schemas/read.ts';
import { BreweryMarker, DriverHolder } from '../schemas/work-root.ts';

/** A driver's held lock; `held` turns false once it is released. */
export interface DriverLock {
  /** The driver's owner: the name its leases carry, the same across its restarts. */
  readonly owner: string;
  /** The lock file. */
  readonly path: string;
  readonly held: boolean;
  /** Releases the lock; does nothing once released. */
  release(): void;
}

export interface DriverLockOptions {
  /** `owner/name` of the Brewery repository. */
  brewery: string;
  /** A path segment: `cellar`, or a session's id that the session keeps when it is resumed. */
  owner: string;
  /** This process; recorded with the lock for the refusal message only. Default `process.pid`. */
  pid?: number;
  /** Default the system clock. */
  now?: () => Date;
  /**
   * How long to wait for a lock that another process holds before refusing; default 2 s, since
   * Windows may free the lock of a process that died a little late.
   */
  waitMs?: number;
}

/** The work root belongs to another Brewery. */
export class OtherBreweryError extends Error {
  readonly marker: string;
  readonly brewery: string;

  constructor(marker: string, brewery: string, ours: string) {
    super(
      `The work root belongs to the Brewery ${brewery} (${marker}), not ${ours}: give this Brewery a work root of its own`,
    );
    this.name = 'OtherBreweryError';
    this.marker = marker;
    this.brewery = brewery;
  }
}

/** Another process runs this driver: its lock is taken. */
export class DriverRunningError extends Error {
  readonly path: string;
  readonly holder: DriverHolder | undefined;

  constructor(owner: string, path: string, holder: DriverHolder | undefined) {
    const by =
      holder === undefined ? '' : ` by process ${holder.pid}, started at ${holder.startedAt}`;
    super(
      `The driver ${owner} already runs on this work root: its lock ${path} is held${by}. Stop it first, or resume it there`,
    );
    this.name = 'DriverRunningError';
    this.path = path;
    this.holder = holder;
  }
}

// SQLite's result code when another connection holds a lock it needs.
const SQLITE_BUSY = 5;
/** Windows may free the lock of a process that died a little after the process is gone. */
const WAIT_MS = 2_000;

// Claims the work root for the Brewery, or checks that it is the Brewery's. The marker is made
// whole next to its place and linked in, so it appears complete and only once, whoever is first.
const claimWorkRoot = (workRoot: string, brewery: string, pid: number): void => {
  const marker = join(workRoot, 'brewery.json');
  const draft = join(workRoot, `brewery.json.${pid}.draft`);
  writeFileSync(draft, `${JSON.stringify({ brewery })}\n`);
  try {
    linkSync(draft, marker);
  } catch (error) {
    if (errorCode(error) !== 'EEXIST') throw error;
  } finally {
    rmSync(draft, { force: true });
  }
  // A BOM or CRLF from an editor is fine; anything but exactly a Brewery is not.
  const read = readJsonc(readFileSync(marker, 'utf8'), BreweryMarker);
  if (!read.valid) {
    throw new Error(
      `The work root's Brewery marker ${marker} cannot be read (${read.reason}): remove it only when no other Brewery uses this work root`,
    );
  }
  const recorded = read.value.brewery;
  // GitHub names are case-insensitive.
  if (recorded.toLowerCase() !== brewery.toLowerCase()) {
    throw new OtherBreweryError(marker, recorded, brewery);
  }
};

// Only for a refusal's message: a holder file that is missing or broken names no one.
const holderOf = (path: string): DriverHolder | undefined => {
  try {
    const read = readJsonc(readFileSync(path, 'utf8'), DriverHolder);
    return read.valid ? read.value : undefined;
  } catch {
    return undefined;
  }
};

/**
 * Takes the lock of driver `owner` of `brewery` on the work root, creating the work root when
 * missing. Throws `OtherBreweryError` when the work root is another Brewery's, and
 * `DriverRunningError` when a live process holds the driver's lock. A lock whose process died is
 * free: its file lock died with it, so it is taken over without any cleanup.
 */
export const lockDriver = (workRoot: string, options: DriverLockOptions): DriverLock => {
  const { brewery, owner, pid = process.pid, now = () => new Date(), waitMs = WAIT_MS } = options;
  if (!Repo.safeParse(brewery).success) {
    throw new Error(`The Brewery ${JSON.stringify(brewery)} is no owner/name`);
  }
  if (!PathSafeId.safeParse(owner).success) {
    throw new Error(`The driver owner ${JSON.stringify(owner)} must be one path segment`);
  }
  mkdirSync(join(workRoot, 'drivers'), { recursive: true });
  claimWorkRoot(workRoot, brewery, pid);

  const path = join(workRoot, 'drivers', `${owner}.lock`);
  const holderPath = join(workRoot, 'drivers', `${owner}.holder.json`);
  // A SQLite database in exclusive locking mode keeps the lock of its first write until it is
  // closed, and the file lock under it (fcntl, LockFileEx) dies with the process: no stale lock
  // to detect, and no pid that a new process may reuse. A held lock is waited for `waitMs`.
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
    if ((error as { errcode?: unknown }).errcode === SQLITE_BUSY) {
      throw new DriverRunningError(owner, path, holderOf(holderPath));
    }
    throw error;
  }
  // Written under the lock, for the message a refused driver shows; nothing decides by it. When
  // it cannot be written, the lock goes too: no handle would be left to release it.
  const holder: DriverHolder = { pid, startedAt: now().toISOString() };
  try {
    writeFileSync(holderPath, `${JSON.stringify(holder)}\n`);
  } catch (error) {
    db.close();
    throw error;
  }
  let held = true;
  return {
    owner,
    path,
    get held() {
      return held;
    },
    release() {
      if (!held) return;
      held = false;
      // The lock first: a holder file a scanner keeps busy must not keep the lock taken. A process
      // that takes the lock in between may lose its holder file here; that only leaves its name
      // out of a refusal's message.
      db.close();
      try {
        rmSync(holderPath, { force: true });
      } catch {
        // The next holder overwrites it.
      }
    },
  };
};
