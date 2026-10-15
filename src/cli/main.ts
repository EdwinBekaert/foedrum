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
        resolve: (name) => resolveExecutable(name),
        platform: process.platform,
        kernelRelease: release(),
        node: process.versions.node,
        cwd,
      }),
    // Never creates a store: a read in the wrong folder says so instead of making an empty one.
    openStore: (path) => (existsSync(path) ? openSqliteEventStore(path) : undefined),
  });
  process.stdout.write(stdout);
  process.stderr.write(stderr);
  process.exitCode = exitCode;
} catch (error) {
  // A store that cannot be read, for example: one line, as for every other failure.
  process.stderr.write(`foedrum: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
