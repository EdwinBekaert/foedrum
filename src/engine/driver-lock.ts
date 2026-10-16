// One Brewery per work root, and one process per driver (ADR 0037). The work root records the
// Brewery it belongs to, and every driver of that Brewery (the Cellar, each interactive session)
// holds a lock of its own there, which the operating system releases when its process dies.

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
}

/** Who held a driver's lock, as recorded when it took the lock. */
export interface Holder {
  pid: number;
  startedAt: string;
}

/** The work root belongs to another Brewery. */
export class OtherBreweryError extends Error {
  readonly marker: string = '';
  readonly brewery: string = '';

  constructor(_marker: string, _brewery: string, _ours: string) {
    super('not implemented');
    throw new Error('not implemented');
  }
}

/** Another process runs this driver: its lock is taken. */
export class DriverRunningError extends Error {
  readonly path: string = '';
  readonly holder: Holder | undefined;

  constructor(_owner: string, _path: string, _holder: Holder | undefined) {
    super('not implemented');
    throw new Error('not implemented');
  }
}

/**
 * Takes the lock of driver `owner` of `brewery` on the work root, creating the work root when
 * missing. Throws `OtherBreweryError` when the work root is another Brewery's, and
 * `DriverRunningError` when a live process holds the driver's lock.
 */
export const lockDriver = (_workRoot: string, _options: DriverLockOptions): DriverLock => {
  throw new Error('not implemented');
};
