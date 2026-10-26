// `foedrum brew` on the real machine (ADR 0123): its owner from `--as` or the Claude Code session,
// the Brewery's files read as serve reads them, and runBrew (brew.ts) on serve's shell
// (serve-shell.ts) with the real git until the batch stops or a stop signal. On a terminal outside
// Claude Code, an interactive step's session opens in the foreground (ADR 0222). cli-main.ts loads it.

import { interactiveBrewerRunner } from '../brewers/interactive-runner.ts';
import { environmentVariable } from '../platform/executables.ts';
import { foregroundProcess } from '../platform/processes.ts';
import type { BrewCommand } from '../schemas/commands.ts';
import type { Surface } from '../schemas/events.ts';
import { runGit } from '../workspace/git.ts';
import { type BrewRequest, runBrew } from './brew.ts';
import { brewOwner } from './driver-owner.ts';
import { foregroundGate } from './foreground-gate.ts';
import { liveTerminal } from './live-terminal.ts';
import { terminalEnv } from './resume.ts';
import type { CliResult } from './run.ts';
import type { LiveTerminal, ServeShell } from './serve.ts';
import { readServeSetup, type StartOptions, thisMachineAwake } from './serve-main.ts';
import { listenWhileServing, serveShell } from './serve-shell.ts';

/**
 * Why brew opens no interactive step's session here (ADR 0222): claude needs the terminal, which a
 * Claude Code session keeps, and stdin must be one.
 */
export const noSessionsOf = (
  env: Readonly<Record<string, string | undefined>>,
  platform: NodeJS.Platform,
  stdinIsTTY: boolean,
): BrewRequest['noSessions'] => {
  if (environmentVariable(env, 'CLAUDE_CODE_CHILD_SESSION', platform) === '1') return 'claude-code';
  return stdinIsTTY ? undefined : 'no-terminal';
};

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
    // On a terminal every lasting line, the state branch's too, goes over the live line.
    const print = terminal?.print ?? ((line: string) => process.stdout.write(`${line}\n`));
    // While claude has the terminal, brew's lines wait, its live line is not drawn, and Ctrl+C is
    // claude's, as for resume (ADR 0127, ADR 0222).
    const gate = foregroundGate(print, listening.listen);
    let foreground = false;
    const live: LiveTerminal | undefined = terminal && {
      columns: terminal.columns,
      onResize: terminal.onResize,
      clear: () => {
        if (!foreground) terminal.clear();
      },
      rewrite: (text) => {
        if (!foreground) terminal.rewrite(text);
      },
    };
    const noSessions = noSessionsOf(env, process.platform, process.stdin.isTTY === true);
    const base = serveShell(setup, {
      root: cwd,
      git: runGit,
      out: gate.out,
      listen: gate.listen,
      command: 'brew',
      keepAwake: thisMachineAwake(options),
    });
    const shell: ServeShell = {
      ...base,
      // A live line only where standard output is a terminal that takes it (ADR 0174).
      ...(live === undefined ? {} : { terminal: live }),
      // Every other attempt runs headless, as serve's (ADR 0222).
      ...(noSessions === undefined
        ? {
            runner: (claude, plan) =>
              interactiveBrewerRunner({
                claude,
                plan,
                opensResumed: false,
                setup: base.setup,
                terminalEnv: terminalEnv(env, process.platform),
                platform: process.platform,
                say: print,
                foreground: (program, args, folder, variables) =>
                  gate.foreground(async () => {
                    terminal?.clear();
                    foreground = true;
                    try {
                      return await foregroundProcess(program, args, folder, variables);
                    } finally {
                      foreground = false;
                    }
                  }),
              }),
          }
        : {}),
    };
    const exitCode = await runBrew(setup, shell, {
      target: input.issue,
      owner: owner.owner,
      ...issued,
      ...(input.take === true ? { take: true } : {}),
      ...(noSessions === undefined ? {} : { noSessions }),
    });
    return { exitCode, stdout: '', stderr: '' };
  } finally {
    listening.stop();
  }
};
