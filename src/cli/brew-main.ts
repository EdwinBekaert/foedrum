// `foedrum brew` on the real machine (ADR 0123): its owner from `--as` or the Claude Code session,
// the Brewery's files read as serve reads them, and runBrew (brew.ts) on serve's shell
// (serve-shell.ts) with the real git until the batch stops or a stop signal. cli-main.ts loads it.

import { userInfo } from 'node:os';
import { userName } from '../platform/env.ts';
import type { BrewCommand } from '../schemas/commands.ts';
import { runGit } from '../workspace/git.ts';
import { brewOwner, runBrew } from './brew.ts';
import type { CliResult } from './run.ts';
import { readServeSetup, type StartOptions } from './serve-main.ts';
import { listenWhileServing, serveShell } from './serve-shell.ts';

/**
 * Brews the batch of `input.issue` in the Brewery checkout `cwd`. A driver with no owner is a
 * mistake of the command line (exit 2); its lines go straight to the terminal.
 */
export const brewFromCheckout = async (
  cwd: string,
  input: BrewCommand,
  options?: StartOptions,
): Promise<CliResult> => {
  const owner = brewOwner(input.as, process.env);
  if ('refused' in owner) {
    return { exitCode: 2, stdout: '', stderr: `foedrum brew: ${owner.refused}\n` };
  }
  const ready = await readServeSetup(cwd, 'brew', options);
  if (ready.kind === 'refused') return ready.result;
  const { setup } = ready;
  // The stop signals are listened for while brew runs, and no longer once it returns.
  const listening = listenWhileServing(process);
  try {
    const shell = serveShell(setup, {
      root: cwd,
      git: runGit,
      out: (line) => process.stdout.write(`${line}\n`),
      listen: listening.listen,
      command: 'brew',
    });
    const exitCode = await runBrew(setup, shell, {
      target: input.issue,
      owner: owner.owner,
      by: userName(() => userInfo().username, process.env),
      via: 'terminal',
    });
    return { exitCode, stdout: '', stderr: '' };
  } finally {
    listening.stop();
  }
};
