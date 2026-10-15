// `npm run deps:sync`: runs npm ci when node_modules no longer matches package-lock.json, as
// after a `git pull` that changed the lock file. deps-sync/core.ts decides; this shell reads the
// files and runs npm (ADR 0021). The SessionStart hook runs it, and the gate (precheck.ts) uses
// `outOfDate` to block a push from a stale tree with one clear line.

import type { RunProcess } from './process-runner.ts';

// The text of a file, or undefined when it cannot be read.
export type ReadText = (path: string) => Promise<string | undefined>;

export interface OutOfDate {
  // The folder npm runs in: the nearest one up from the working directory with a package.json.
  root: string;
  reason: string;
}

export const outOfDate = async (_cwd: string, _read?: ReadText): Promise<OutOfDate | undefined> => {
  throw new Error('not implemented');
};

// What it did, one line each; nothing when node_modules is up to date.
export const syncDeps = async (
  _cwd: string,
  _env: NodeJS.ProcessEnv,
  _execPath: string,
  _runProcess: RunProcess,
  _read?: ReadText,
): Promise<string[]> => {
  throw new Error('not implemented');
};

if (import.meta.main) throw new Error('not implemented');
