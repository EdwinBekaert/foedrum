#!/usr/bin/env node
// `foedrum`, the command-line program (ADR 0016): runs one command of the command layer against
// this machine and the Brewery in the working directory.

import { existsSync } from 'node:fs';
import { release, userInfo } from 'node:os';
import { openSqliteEventStore } from '../engine/sqlite-event-store.ts';
import { userName } from '../platform/env.ts';
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
    openWritableStore: (path) => (existsSync(path) ? openSqliteEventStore(path) : undefined),
    // Recipe files reach the engine's Recipe interface in a follow-up of #37: until then a
    // command that schedules a step is refused with "the Brewery has no recipe <name>".
    recipes: { find: () => undefined },
    user: () => userName(() => userInfo().username, process.env),
    surface: 'terminal',
    now: () => new Date(),
  });
  process.stdout.write(stdout);
  process.stderr.write(stderr);
  process.exitCode = exitCode;
} catch (error) {
  // A store that cannot be read, for example: one line, as for every other failure.
  process.stderr.write(`foedrum: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
