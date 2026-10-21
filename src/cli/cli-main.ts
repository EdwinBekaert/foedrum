// `foedrum`'s commands on the real machine, from the checkout `cwd`: the wiring main.ts runs.

import { existsSync, readFileSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { join } from 'node:path';
import { breweryRecipes } from '../engine/brewery-files.ts';
import { openSqliteEventStore } from '../engine/sqlite-event-store.ts';
import { userName } from '../platform/env.ts';
import { runGit } from '../workspace/git.ts';
import type { DoctorShell } from './doctor-facts.ts';
import { doctorFromCheckout } from './doctor-main.ts';
import { readKeptBranches } from './kept-branches-git.ts';
import { type CliResult, runCli } from './run.ts';
import { attemptClone } from './serve-config.ts';

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
  const readText = (...path: string[]): string | undefined => {
    const file = join(cwd, ...path);
    return existsSync(file) ? readFileSync(file, 'utf8') : undefined;
  };
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
      // Through the engine's git, in each repository's clone as serve finds it (ADR 0092).
      readKeptBranches: (state, unpushed) => {
        const files = {
          config: readText('foedrum.jsonc'),
          local: readText('.foedrum', 'local.jsonc'),
        };
        const cloneOf = (repo: string) => attemptClone(files, homedir(), repo);
        return readKeptBranches(state, unpushed, { git: runGit, cloneOf });
      },
      config: () => {
        throw new Error('not implemented');
      },
      claims: () => {
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
