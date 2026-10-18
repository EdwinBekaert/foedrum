#!/usr/bin/env node
// `foedrum`, the command-line program (ADR 0016): runs one command of the command layer against
// this machine and the Brewery in the working directory.

import { existsSync } from 'node:fs';
import { userInfo } from 'node:os';
import { breweryRecipes } from '../engine/brewery-files.ts';
import { openSqliteEventStore } from '../engine/sqlite-event-store.ts';
import { userName } from '../platform/env.ts';
import { doctorFromCheckout } from './doctor-main.ts';
import { runCli } from './run.ts';

const cwd = process.cwd();
try {
  const { exitCode, stdout, stderr } = await runCli(process.argv.slice(2), {
    cwd,
    gatherDoctorFacts: () => doctorFromCheckout(cwd),
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
    // Loaded only for serve: it brings the runner, git and the state branch.
    serve: async () => (await import('./serve-main.ts')).serveFromCheckout(cwd),
  });
  process.stdout.write(stdout);
  process.stderr.write(stderr);
  process.exitCode = exitCode;
} catch (error) {
  // A store that cannot be read, for example: one line, as for every other failure.
  process.stderr.write(`foedrum: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
