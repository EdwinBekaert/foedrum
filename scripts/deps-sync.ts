// `npm run deps:sync`: runs npm ci when node_modules no longer matches package-lock.json, as
// after a `git pull` that changed the lock file. deps-sync/core.ts decides; this shell reads the
// files and runs npm (ADR 0021). The SessionStart hook runs it, and the gate (precheck.ts) uses
// `outOfDate` to block a push from a stale tree with one clear line. It never fails, and prints
// nothing when node_modules is up to date: SessionStart output goes into the session's context.

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { staleReason } from './deps-sync/core.ts';
import type { RunProcess } from './process-runner.ts';

// The text of a file, or undefined when it cannot be read.
export type ReadText = (path: string) => Promise<string | undefined>;

const readText: ReadText = (path) => readFile(path, 'utf8').catch(() => undefined);

export interface OutOfDate {
  // The folder npm runs in: the nearest one up from the working directory with a package.json.
  root: string;
  reason: string;
}

const MAX_OUTPUT_CHARS = 2000;

const packageRoot = async (cwd: string, read: ReadText): Promise<string | undefined> => {
  for (let dir = cwd; ; dir = dirname(dir)) {
    if ((await read(join(dir, 'package.json'))) !== undefined) return dir;
    if (dirname(dir) === dir) return undefined;
  }
};

export const outOfDate = async (
  cwd: string,
  read: ReadText = readText,
): Promise<OutOfDate | undefined> => {
  const root = await packageRoot(cwd, read);
  if (root === undefined) return undefined;
  const lock = await read(join(root, 'package-lock.json'));
  if (lock === undefined) return undefined;
  const reason = staleReason(lock, await read(join(root, 'node_modules', '.package-lock.json')));
  return reason === undefined ? undefined : { root, reason };
};

// What it did, one line each; nothing when node_modules is up to date.
export const syncDeps = async (
  cwd: string,
  env: NodeJS.ProcessEnv,
  execPath: string,
  runProcess: RunProcess,
  read: ReadText = readText,
): Promise<string[]> => {
  const stale = await outOfDate(cwd, read);
  if (stale === undefined) return [];
  const what = `node_modules is out of date with package-lock.json (${stale.reason})`;
  const npmCli = env.npm_execpath;
  if (npmCli === undefined || npmCli === '') {
    return [`${what}; npm_execpath is not set, so run npm ci yourself`];
  }
  const { exitCode, output } = await runProcess(execPath, [npmCli, 'ci'], stale.root);
  if (exitCode === 0) {
    return [`node_modules was out of date with package-lock.json (${stale.reason}); ran npm ci`];
  }
  const code = exitCode === null ? 'no exit code' : `exit ${exitCode}`;
  const tail = output.trim().slice(-MAX_OUTPUT_CHARS);
  return [`${what}; npm ci failed (${code}), run it yourself:\n${tail}`];
};

if (import.meta.main) {
  try {
    const { spawnProcess } = await import('./process-runner.ts');
    const lines = await syncDeps(process.cwd(), process.env, process.execPath, spawnProcess);
    for (const line of lines) console.log(`deps:sync: ${line}`);
  } catch (error) {
    console.log(`deps:sync failed: ${String(error)}`);
  }
}
