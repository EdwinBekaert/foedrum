// `foedrum brew` on the real machine (ADR 0123): its owner from `--as`, the Claude Code session or
// else `terminal` (ADR 0259), the Brewery's files read as serve reads them, and runBrew (brew.ts) on
// serve's shell (serve-shell.ts) with the real git until the batch stops or a stop signal. On a
// terminal outside Claude Code, an interactive step's session opens in the foreground (ADR 0222).
// cli-main.ts loads it.

import { existsSync } from 'node:fs';
import { interactiveBrewerRunner } from '../brewers/interactive-runner.ts';
import type { BrewerRunner } from '../engine/brewer-runner.ts';
import { emptyState, fold, type State } from '../engine/fold.ts';
import { openSqliteEventStore } from '../engine/sqlite-event-store.ts';
import { sameRepo } from '../engine/task-tree.ts';
import { environmentVariable, resolveExecutable } from '../platform/executables.ts';
import { openInNewWindow, type WindowFacts } from '../platform/new-window.ts';
import { foregroundProcess, type LaunchProcess, launchProcess } from '../platform/processes.ts';
import type { BrewCommand, LauterCommand, MashCommand, OrderTarget } from '../schemas/commands.ts';
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
 * brew's shell: with sessions, a runner that opens an interactive step's session in the foreground
 * and runs every other attempt headless, a resumed one too, as serve's (ADR 0222); without, serve's.
 */
export const brewShellOf = (
  base: ServeShell,
  noSessions: BrewRequest['noSessions'],
  interactive: (
    claude: string,
    plan: Parameters<ServeShell['runner']>[1],
    opensResumed: boolean,
  ) => BrewerRunner,
): ServeShell =>
  noSessions === undefined
    ? { ...base, runner: (claude, plan) => interactive(claude, plan, false) }
    : base;

/** What brew is asked to brew, as whom and who asked, and why it opens no session, if it does not. */
export const brewRequestOf = (
  input: BrewCommand | MashCommand | LauterCommand,
  owner: string,
  issued: { by: string; via: Surface },
  noSessions: BrewRequest['noSessions'],
  /** For `foedrum lauter`: the issue of its batch (`lauterTarget`). */
  target?: OrderTarget,
): BrewRequest => {
  if (input.command !== 'lauter') return brewOrMash(input, owner, issued, noSessions);
  if (target === undefined) throw new Error(`foedrum lauter ${input.batch} needs its issue`);
  // A lauter takes the batch over from the driver that holds it, as brew --take (ADR 0286).
  return {
    target,
    owner,
    ...issued,
    take: true,
    lauter: input.batch,
    ...(noSessions === undefined ? {} : { noSessions }),
  };
};

const brewOrMash = (
  input: BrewCommand | MashCommand,
  owner: string,
  issued: { by: string; via: Surface },
  noSessions: BrewRequest['noSessions'],
): BrewRequest => ({
  target: input.issue,
  owner,
  ...issued,
  ...(input.take === true ? { take: true } : {}),
  ...(input.command === 'mash' ? { mash: true } : {}),
  ...(noSessions === undefined ? {} : { noSessions }),
});

/** The issue of the batch `foedrum lauter` names, as brew takes it, or why it has none (ADR 0286). */
export const lauterTarget = (
  state: State,
  batchId: string,
  repositories: readonly { alias: string; repo: string }[],
): { target: OrderTarget } | { refused: string } => {
  const batch = state.batches.get(batchId);
  if (batch === undefined) return { refused: `there is no batch ${batchId}` };
  const { issue, repo } = batch;
  if (repo === undefined) return { target: { issue } };
  const alias = repositories.find((each) => sameRepo(each.repo, repo))?.alias;
  return alias === undefined
    ? {
        refused: `batch ${batchId} is of ${repo}, which foedrum.jsonc names with no alias and intake`,
      }
    : { target: { alias, issue } };
};

/** The state of the Brewery's event store at `path`, read only; none yet is no batch. */
const readState = (path: string): State => {
  if (!existsSync(path)) return emptyState;
  const store = openSqliteEventStore(path, { readOnly: true });
  try {
    return fold(store.eventsAfter(0).map(({ event }) => event));
  } finally {
    store.close();
  }
};

/** What `--new-window` starts the brew with: the machine's launcher facts, node and program. */
export interface NewWindowDeps extends WindowFacts {
  /** This node. */
  execPath: string;
  /** The `foedrum` program this node runs. */
  script: string;
  exec: LaunchProcess;
}

/** The variables that tell a brew it runs inside a Claude Code session (noSessionsOf, brewOwner). */
const SESSION_VARIABLES = ['CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_SESSION_ID'];

/** The real machine's: this process's node, program and platform, and its PATH. */
export const thisMachine = (env: Readonly<Record<string, string | undefined>>): NewWindowDeps => {
  const { platform } = process;
  return {
    platform,
    env,
    find: (name) => resolveExecutable(name, { env, platform }),
    execPath: process.execPath,
    script: process.argv[1] ?? '',
    exec: launchProcess,
  };
};

/**
 * Opens a new terminal window that runs `foedrum brew <issue> --take` with this node and program,
 * for the plugin's session, which cannot hand its terminal to claude (ADR 0222). Where none can
 * open, it says the line to run in a terminal (exit 5).
 */
export const brewInNewWindow = async (
  cwd: string,
  input: BrewCommand,
  owner: string,
  deps: NewWindowDeps,
): Promise<CliResult> => {
  const { alias, issue } = input.issue;
  const target = `${alias === undefined ? '' : `${alias}#`}${issue}`;
  // As this brew's owner: a window may start with none of this session's variables (macOS).
  const words = ['brew', target, '--take', '--as', owner];
  const shown = `foedrum ${words.join(' ')}`;
  // Without the Claude Code session's variables, so the window's brew opens the session.
  const named = (name: string) => (deps.platform === 'win32' ? name.toUpperCase() : name);
  const env = Object.fromEntries(
    Object.entries(deps.env).filter(([name]) => !SESSION_VARIABLES.includes(named(name))),
  );
  const line = { cwd, program: deps.execPath, args: [deps.script, ...words], env };
  const opened = await openInNewWindow(deps, line, deps.exec);
  if (opened.kind === 'opened') {
    // The launcher returned: the window shows whether it opened.
    const said = `foedrum brew: asked for a new window that runs ${shown}; exit its claude session there when the step is done, then check the batch with foedrum status. If no window opened, run that command in a terminal`;
    return { exitCode: 0, stdout: `${said}\n`, stderr: '' };
  }
  const said = `foedrum brew: no new window can open here (${opened.why}); run ${shown} in a terminal`;
  return { exitCode: 5, stdout: '', stderr: `${said}\n` };
};

/**
 * Brews the batch of `input.issue` in the Brewery checkout `cwd`, as the command layer `issued` it.
 * A session in `env` that names no driver, without `--as`, is a mistake of the command line
 * (exit 2); its lines go straight to the terminal.
 */
export const brewFromCheckout = async (
  cwd: string,
  input: BrewCommand | MashCommand | LauterCommand,
  issued: { by: string; via: Surface },
  options?: StartOptions,
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<CliResult> => {
  const owner = brewOwner(input.as, env);
  if ('refused' in owner) {
    return { exitCode: 2, stdout: '', stderr: `foedrum ${input.command}: ${owner.refused}\n` };
  }
  if (input.command === 'brew' && input['new-window'] === true)
    return brewInNewWindow(cwd, input, owner.owner, thisMachine(env));
  const ready = await readServeSetup(cwd, input.command, options);
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
      command: input.command,
      keepAwake: thisMachineAwake(options),
    });
    const shell = brewShellOf(
      // A live line only where standard output is a terminal that takes it (ADR 0174).
      live === undefined ? base : { ...base, terminal: live },
      noSessions,
      (claude, plan, opensResumed) =>
        interactiveBrewerRunner({
          claude,
          plan,
          opensResumed,
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
    );
    let target: OrderTarget | undefined;
    if (input.command === 'lauter') {
      const found = lauterTarget(readState(setup.store), input.batch, setup.intake.repositories);
      if ('refused' in found) {
        return {
          exitCode: 5,
          stdout: '',
          stderr: `foedrum lauter: ${found.refused}\n`,
        };
      }
      target = found.target;
    }
    const request = brewRequestOf(input, owner.owner, issued, noSessions, target);
    const exitCode = await runBrew(setup, shell, request);
    return { exitCode, stdout: '', stderr: '' };
  } finally {
    listening.stop();
  }
};
