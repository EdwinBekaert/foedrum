// `foedrum`'s commands on the real machine, from the checkout `cwd`: the wiring main.ts runs.

import { existsSync } from 'node:fs';
import { userInfo } from 'node:os';
import { breweryRecipes } from '../engine/brewery-files.ts';
import { openSqliteEventStore } from '../engine/sqlite-event-store.ts';
import { userName } from '../platform/env.ts';
import type { DoctorShell } from './doctor-facts.ts';
import { doctorFromCheckout } from './doctor-main.ts';
import { type CliResult, runCli } from './run.ts';

/**
 * Runs one command (`argv`) of the command layer in the Brewery checkout `cwd`. doctor's and
 * serve's facts, gh's login among them, come through `exec` and `resolve`, default the real runner
 * and PATH, so a test gives fakes or a canned answer for gh's login. A failure the command layer
 * throws, such as a store that cannot be read, is one line, as for every other failure.
 */
export const cliFromCheckout = async (
  argv: string[],
  cwd: string,
  options?: Partial<Pick<DoctorShell, 'exec' | 'resolve'>>,
): Promise<CliResult> => {
  try {
    return await runCli(argv, {
      cwd,
      gatherDoctorFacts: () => doctorFromCheckout(cwd, options),
      // Never creates or changes a store (ADR 0030): a read in the wrong folder says so instead of
      // making an empty one, and an older Cellar's store is not migrated under it.
      openStore: (path) =>
        existsSync(path) ? openSqliteEventStore(path, { readOnly: true }) : undefined,
      // A command that changes state never creates a store either; it opens the Brewery's.
      openWritableStore: (path) => (existsSync(path) ? openSqliteEventStore(path) : undefined),
      // Files that do not load refuse the command with doctor's line (ADR 0053).
      recipes: () => breweryRecipes(cwd),
      user: () => userName(() => userInfo().username, process.env),
      surface: 'terminal',
      now: () => new Date(),
      readKeptBranches: async () => {
        throw new Error('not implemented');
      },
      // Loaded only for serve: it brings the runner, git and the state branch.
      serve: async () => (await import('./serve-main.ts')).serveFromCheckout(cwd, options),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { exitCode: 1, stdout: '', stderr: `foedrum: ${message}\n` };
  }
};
