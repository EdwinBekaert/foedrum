// `foedrum serve` on the real machine (ADR 0063): reads the Brewery's files in the working
// directory, asks doctor for claude and the isolation level, and runs the Cellar (serve.ts) on
// the real machine (serve-shell.ts) with the real git until a stop signal. Only main.ts loads it;
// test/integration/serve.test.ts runs it as the real program.

import { existsSync, readFileSync } from 'node:fs';
import { homedir, release } from 'node:os';
import { join } from 'node:path';
import { readBreweryFiles } from '../engine/brewery-files.ts';
import { resolveExecutable } from '../platform/executables.ts';
import { execProcess } from '../platform/processes.ts';
import { runGit } from '../workspace/git.ts';
import { diagnose } from './doctor.ts';
import { gatherDoctorFacts } from './doctor-facts.ts';
import { type CliResult, printable } from './run.ts';
import { runServe } from './serve.ts';
import { serveSetup } from './serve-config.ts';
import { serveShell } from './serve-shell.ts';

const readIfThere = (path: string): string | undefined =>
  existsSync(path) ? readFileSync(path, 'utf8') : undefined;

/** Runs the Cellar in the Brewery checkout `cwd` until Ctrl+C. */
export const serveFromCheckout = async (cwd: string): Promise<CliResult> => {
  // Doctor's tools and isolation only: serve reads and checks the Brewery's files itself.
  const facts = await gatherDoctorFacts({
    exec: execProcess,
    resolve: resolveExecutable,
    platform: process.platform,
    kernelRelease: release(),
    node: process.versions.node,
    execPath: process.execPath,
    cwd,
  });
  const ready = serveSetup({
    root: cwd,
    home: homedir(),
    platform: process.platform,
    env: process.env,
    files: {
      config: readIfThere(join(cwd, 'foedrum.jsonc')),
      local: readIfThere(join(cwd, '.foedrum', 'local.jsonc')),
      models: readIfThere(join(cwd, 'models.jsonc')),
      brewery: readBreweryFiles(cwd),
    },
    diagnosis: diagnose(facts),
  });
  if (ready.kind === 'refused') {
    const stderr = ready.problems.map((problem) => `foedrum serve: ${problem}\n`).join('');
    return { exitCode: 1, stdout: '', stderr };
  }
  const { setup } = ready;

  // The stop signals are listened for while serve runs, and no longer once it returns.
  const listening: [NodeJS.Signals, () => void][] = [];
  try {
    const shell = serveShell(setup, {
      root: cwd,
      git: runGit,
      // Notices may carry text a model wrote: never a control character on the terminal.
      out: (line) =>
        process.stdout.write(`${printable(line)}
`),
      listen: (name, handler) => {
        listening.push([name, handler]);
        process.once(name, handler);
      },
    });
    return { exitCode: await runServe(setup, shell), stdout: '', stderr: '' };
  } finally {
    for (const [name, handler] of listening) process.off(name, handler);
  }
};
