// `foedrum brew` on the real machine (ADR 0123): its owner from `--as` or the Claude Code session,
// the Brewery's files read as serve reads them, and runBrew (brew.ts) on serve's shell
// (serve-shell.ts) with the real git until the batch stops or a stop signal. cli-main.ts loads it.

import type { BrewCommand } from '../schemas/commands.ts';
import type { Surface } from '../schemas/events.ts';
import { runGit } from '../workspace/git.ts';
import { runBrew } from './brew.ts';
import { brewOwner } from './driver-owner.ts';
import { liveTerminal } from './live-terminal.ts';
import type { CliResult } from './run.ts';
import type { ServeShell } from './serve.ts';
import { readServeSetup, type StartOptions, thisMachineAwake } from './serve-main.ts';
import { listenWhileServing, serveShell } from './serve-shell.ts';

/**
 * Brews the batch of `input.issue` in the Brewery checkout `cwd`, as the command layer `issued` it.
 * A driver with no owner, from `--as` or the session in `env`, is a mistake of the command line
 * (exit 2); its lines go straight to the terminal.
 */
export const brewFromCheckout = async (
  cwd: string,
  input: BrewCommand,
  issued: { by: string; via: Surface },
  options?: StartOptions,
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<CliResult> => {
  const owner = brewOwner(input.as, env);
  if ('refused' in owner) {
    return { exitCode: 2, stdout: '', stderr: `foedrum brew: ${owner.refused}\n` };
  }
  const ready = await readServeSetup(cwd, 'brew', options);
  if (ready.kind === 'refused') return ready.result;
  const { setup } = ready;
  // The stop signals are listened for while brew runs, and no longer once it returns.
  const listening = listenWhileServing(process);
  try {
    const terminal = liveTerminal(process.stdout, env);
    const shell: ServeShell = {
      ...serveShell(setup, {
        root: cwd,
        git: runGit,
        // On a terminal every lasting line, the state branch's too, goes over the live line.
        out: terminal?.print ?? ((line) => process.stdout.write(`${line}\n`)),
        listen: listening.listen,
        command: 'brew',
        keepAwake: thisMachineAwake(options),
      }),
      // A live line only where standard output is a terminal that takes it (ADR 0174).
      ...(terminal === undefined ? {} : { terminal }),
    };
    const exitCode = await runBrew(setup, shell, {
      target: input.issue,
      owner: owner.owner,
      ...issued,
      ...(input.take === true ? { take: true } : {}),
    });
    return { exitCode, stdout: '', stderr: '' };
  } finally {
    listening.stop();
  }
};
