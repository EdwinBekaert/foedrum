#!/usr/bin/env node
// `foedrum`, the command-line program (ADR 0016): runs one command of the command layer against
// this machine and the Brewery in the working directory.

import { existsSync } from 'node:fs';
import { release } from 'node:os';
import { openSqliteEventStore } from '../engine/sqlite-event-store.ts';
import { resolveExecutable } from '../platform/executables.ts';
import { execProcess } from '../platform/processes.ts';
import { gatherDoctorFacts } from './doctor-facts.ts';
import { runCli } from './run.ts';

const cwd = process.cwd();
try {
  const { exitCode, stdout, stderr } = await runCli(process.argv.slice(2), {
    cwd,
    gatherDoctorFacts: () =>
      gatherDoctorFacts({
        exec: execProcess,
        resolve: resolveExecutable,
        platform: process.platform,
        kernelRelease: release(),
        node: process.versions.node,
        execPath: process.execPath,
        cwd,
      }),
    // Never creates or changes a store (ADR 0030): a read in the wrong folder says so instead of
    // making an empty one, and an older Cellar's store is not migrated under it.
    openStore: (path) =>
      existsSync(path) ? openSqliteEventStore(path, { readOnly: true }) : undefined,
    // A command that changes state never creates a store either; it opens the Brewery's.
    // Stubs until the commands that change state run.
    openWritableStore: () => {
      throw new Error('not implemented');
    },
    recipes: {
      find: () => {
        throw new Error('not implemented');
      },
    },
    user: () => {
      throw new Error('not implemented');
    },
    surface: 'terminal',
    now: () => {
      throw new Error('not implemented');
    },
  });
  process.stdout.write(stdout);
  process.stderr.write(stderr);
  process.exitCode = exitCode;
} catch (error) {
  // A store that cannot be read, for example: one line, as for every other failure.
  process.stderr.write(`foedrum: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
