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
import { diagnose, githubHostOfConfig } from './doctor.ts';
import { type DoctorShell, gatherDoctorFacts } from './doctor-facts.ts';
import type { CliResult } from './run.ts';
import { runServe } from './serve.ts';
import { serveSetup } from './serve-config.ts';
import { listenWhileServing, serveShell } from './serve-shell.ts';

const readIfThere = (path: string): string | undefined =>
  existsSync(path) ? readFileSync(path, 'utf8') : undefined;

/**
 * Runs the Cellar in the Brewery checkout `cwd` until Ctrl+C. Its starting facts, gh's login among
 * them, come through `exec` and `resolve`, default the real runner and PATH; a test gives fakes.
 */
export const serveFromCheckout = async (
  cwd: string,
  options?: Partial<Pick<DoctorShell, 'exec' | 'resolve'>>,
): Promise<CliResult> => {
  const { exec = execProcess, resolve = resolveExecutable } = options ?? {};
  const config = readIfThere(join(cwd, 'foedrum.jsonc'));
  // Doctor's tools, isolation and gh's login only: serve reads and checks the Brewery's files
  // itself, and refuses on a required problem, such as no gh login for its host (ADR 0073).
  const facts = await gatherDoctorFacts({
    exec,
    resolve,
    platform: process.platform,
    kernelRelease: release(),
    node: process.versions.node,
    execPath: process.execPath,
    cwd,
    githubHost: githubHostOfConfig(config),
  });
  const ready = serveSetup({
    root: cwd,
    home: homedir(),
    platform: process.platform,
    env: process.env,
    files: {
      config,
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
  const listening = listenWhileServing(process);
  try {
    const shell = serveShell(setup, {
      root: cwd,
      git: runGit,
      out: (line) => process.stdout.write(`${line}\n`),
      listen: listening.listen,
    });
    return { exitCode: await runServe(setup, shell), stdout: '', stderr: '' };
  } finally {
    listening.stop();
  }
};
