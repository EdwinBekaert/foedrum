// The lockfile a release bump leaves behind (ADR 0412): after a brewer's attempt in a batch that
// waited for a release ends with commits, Foedrum refreshes the lockfile beside each manifest those
// commits changed, with the package manager in the setup's sandbox, and commits it on the attempt's
// branch. npm only: `package-lock.json` beside a changed `package.json`.

import type { Env } from '../engine/brewer-env.ts';
import type { ExecProcess } from '../platform/processes.ts';
import type { GravityReading } from '../schemas/events.ts';

/** The command that refreshes an npm lockfile from its manifest, running no package's scripts. */
export const NPM_REFRESH = 'npm install --package-lock-only --ignore-scripts';

/** How long one refresh may run, unless the attempt's deadline comes sooner. */
export const REFRESH_TIMEOUT_MS = 300_000;

/** One lockfile to refresh: its folder, the file, both relative with forward slashes, and how. */
export interface LockfileRefresh {
  folder: string;
  lockfile: string;
  command: string;
}

/** The lockfiles to refresh for the `changed` paths of an attempt's commits. */
export function lockfileRefreshes(_changed: readonly string[]): LockfileRefresh[] {
  throw new Error('not implemented');
}

/** Where and how the refreshes run: the setup's process runner, environment and deadline. */
export interface RefreshRun {
  exec: ExecProcess;
  env: Env;
  deadlineAt: string;
  now: () => Date;
  signal: AbortSignal;
  /** Whether no sandbox holds it: on native Windows (ADR 0158). */
  unsandboxed: boolean;
}

/** What the refreshes in a tree read, and the lockfiles they changed. */
export interface LockfilesRefreshed {
  readings: GravityReading[];
  files: string[];
}

/**
 * Runs each refresh whose lockfile the tree `worktree` holds as a regular file, in its folder,
 * until one does not pass.
 */
export function refreshLockfiles(
  _worktree: string,
  _refreshes: readonly LockfileRefresh[],
  _run: RefreshRun,
): Promise<LockfilesRefreshed> {
  throw new Error('not implemented');
}
