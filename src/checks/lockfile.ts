// The lockfile a release bump leaves behind (ADR 0412): after a brewer's attempt in a batch that
// waited for a release ends with commits, Foedrum refreshes the lockfile beside each manifest those
// commits changed, with the package manager in the setup's sandbox, and commits it on the attempt's
// branch. npm only: `package-lock.json` beside a changed `package.json`.

import { lstat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Env } from '../engine/brewer-env.ts';
import { npmManifest } from '../formats/npm-manifest.ts';
import { pathInside } from '../platform/paths.ts';
import type { ExecProcess } from '../platform/processes.ts';
import { realPath } from '../platform/real-path.ts';
import type { GravityReading } from '../schemas/events.ts';
import { passed } from './gravity.ts';
import { readingOn, runLine } from './setup.ts';

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
export function lockfileRefreshes(changed: readonly string[]): LockfileRefresh[] {
  // A brewer names the paths: one whose name would break a reading's line is left out.
  return changed
    .filter((path) => npmManifest.matches(path) && !ONE_LINE_BREAKER.test(path))
    .map((manifest) => {
      const folder = manifest.slice(0, Math.max(0, manifest.lastIndexOf('/')));
      const lockfile = folder === '' ? NPM_LOCKFILE : `${folder}/${NPM_LOCKFILE}`;
      return { folder, lockfile, command: NPM_REFRESH };
    });
}

const NPM_LOCKFILE = 'package-lock.json';

/** A control character or a line or paragraph separator. */
const ONE_LINE_BREAKER = new RegExp(
  String.raw`[\p{Cc}${String.fromCodePoint(0x2028, 0x2029)}]`,
  'u',
);

/** The bytes of `file` when it is a regular file inside `tree`, through no link; else undefined. */
const regularFile = async (tree: string, file: string): Promise<Buffer | undefined> => {
  const found = await lstat(file).catch(() => undefined);
  if (found?.isFile() !== true) return undefined;
  if (pathInside(realPath(tree), realPath(file)) === undefined) return undefined;
  return readFile(file);
};

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
export async function refreshLockfiles(
  worktree: string,
  refreshes: readonly LockfileRefresh[],
  run: RefreshRun,
): Promise<LockfilesRefreshed> {
  const { exec, env, deadlineAt, now, signal, unsandboxed } = run;
  const readings: GravityReading[] = [];
  const files: string[] = [];
  for (const { folder, lockfile, command } of refreshes) {
    const file = join(worktree, ...lockfile.split('/'));
    // A repository that keeps no lockfile there has none to refresh.
    const before = await regularFile(worktree, file);
    if (before === undefined) continue;
    const cwd = join(worktree, ...folder.split('/').filter((part) => part !== ''));
    const timeoutMs = REFRESH_TIMEOUT_MS;
    const result = await runLine(exec, command, { cwd, env, deadlineAt, now, signal, timeoutMs });
    const reading = { ...readingOn({ kind: 'run', command }, result, unsandboxed), lockfile };
    readings.push(reading);
    if (!passed(reading)) break;
    const after = await regularFile(worktree, file);
    if (after !== undefined && !after.equals(before)) files.push(lockfile);
  }
  return { readings, files };
}
