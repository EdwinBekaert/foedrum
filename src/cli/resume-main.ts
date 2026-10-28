// `foedrum resume` on the real machine (ADR 0126): serve's setup of the Brewery in the working
// directory, its worktrees, the session's transcript under Claude Code's config directory, and
// claude in the foreground with the terminal. main.ts runs it through the command layer; the logic
// is resume.ts's, tested with fakes.

import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname } from 'node:path';
import { writeAttemptSettings } from '../brewers/attempt-settings.ts';
import { writeSystemPromptFile } from '../brewers/claude-runner.ts';
import { interactiveBrewerRunner } from '../brewers/interactive-runner.ts';
import { openSqliteEventStore } from '../engine/sqlite-event-store.ts';
import { environmentVariable } from '../platform/executables.ts';
import { foregroundProcess } from '../platform/processes.ts';
import type { ResumeCommand } from '../schemas/commands.ts';
import type { Surface } from '../schemas/events.ts';
import { ownGitDirsRoot } from '../workspace/attempt-worktrees.ts';
import { openAttemptWorktrees, worktreeClonePath } from '../workspace/attempt-worktrees-git.ts';
import { runGit } from '../workspace/git.ts';
import { foregroundGate } from './foreground-gate.ts';
import { claudeConfigDir, runResume, sessionFoundIn, terminalEnv } from './resume.ts';
import { runResumeRunning } from './resume-running.ts';
import type { CliResult } from './run.ts';
import { readServeSetup, type StartOptions, serveSetupIn } from './serve-main.ts';
import { listenWhileServing, serveShell } from './serve-shell.ts';

// A folder's subfolders, none when it is missing.
const folders = (path: string): string[] =>
  existsSync(path)
    ? readdirSync(path, { withFileTypes: true }).flatMap((entry) =>
        entry.isDirectory() ? [entry.name] : [],
      )
    : [];

/**
 * Takes the running `batchId` over and continues the session of `stepId` in this terminal (ADR
 * 0127): serve's setup and shell, as brew's, with the runner that opens a resumed session in the
 * foreground. While claude has the terminal, the driver's lines wait and a stop signal is claude's.
 */
const resumeRunning = async (
  cwd: string,
  target: { batchId: string; stepId: string },
  issued: { by: string; via: Surface },
  options?: StartOptions,
): Promise<CliResult> => {
  const ready = await readServeSetup(cwd, 'resume', options);
  if (ready.kind === 'refused') return ready.result;
  const { setup } = ready;
  const listening = listenWhileServing(process);
  const write = (line: string) => process.stdout.write(`${line}\n`);
  // The driver's lines wait for claude, and Ctrl+C is claude's while it runs (ADR 0127).
  const gate = foregroundGate(write, listening.listen);
  try {
    const shell = serveShell(setup, {
      root: cwd,
      git: runGit,
      out: gate.out,
      listen: gate.listen,
      command: 'resume',
    });
    const runner = (claude: string, plan: Parameters<typeof shell.runner>[1]) =>
      interactiveBrewerRunner({
        claude,
        plan,
        setup: shell.setup,
        terminalEnv: terminalEnv(process.env, process.platform),
        platform: process.platform,
        say: write,
        foreground: (program, args, folder, env) =>
          gate.foreground(() => foregroundProcess(program, args, folder, env)),
      });
    const owner = `resume-${process.pid}`;
    const exitCode = await runResumeRunning(
      setup,
      { ...shell, runner },
      { ...target, owner, ...issued },
    );
    return { exitCode, stdout: '', stderr: '' };
  } finally {
    listening.stop();
  }
};

/** Runs `foedrum resume` in the Brewery checkout `cwd`; doctor's facts come through `options`. */
export const resumeFromCheckout = async (
  cwd: string,
  input: ResumeCommand,
  issued: { by: string; via: Surface },
  options?: StartOptions,
): Promise<CliResult> => {
  // Ctrl+C is claude's while it runs; foedrum waits to let the lease go.
  const ignore = () => {};
  return runResume(input, {
    cwd,
    openStore: (path) => (existsSync(path) ? openSqliteEventStore(path) : undefined),
    setup: () => serveSetupIn(cwd, options),
    worktrees: async (repository, workRoot) => {
      const { repo } = repository;
      // The clone the attempt's worktree was added to, a managed one included: it ran there.
      // recreate fetches nothing, so the remote is named only as serve's shell names it.
      return openAttemptWorktrees({
        git: runGit,
        workRoot,
        repo,
        clone: worktreeClonePath(workRoot, repository),
        own: { url: `https://github.com/${repo}.git`, root: ownGitDirsRoot(workRoot, repo) },
      });
    },
    sessionFound: (id) =>
      sessionFoundIn(claudeConfigDir(process.env, process.platform, homedir()), id, {
        folders,
        exists: existsSync,
      }),
    writeSettings: (file, settings) => {
      mkdirSync(dirname(file), { recursive: true });
      writeAttemptSettings(file, settings);
    },
    writeSystemPrompt: writeSystemPromptFile,
    terminal: {
      claudeCode:
        environmentVariable(process.env, 'CLAUDE_CODE_CHILD_SESSION', process.platform) === '1',
      tty: process.stdin.isTTY === true,
    },
    env: process.env,
    platform: process.platform,
    claude: async (program, args, folder, env) => {
      process.on('SIGINT', ignore);
      try {
        return await foregroundProcess(program, args, folder, env);
      } finally {
        process.off('SIGINT', ignore);
      }
    },
    now: () => new Date(),
    heartbeat: (everyMs, beat) => {
      const timer = setInterval(beat, everyMs);
      return () => clearInterval(timer);
    },
    say: (line) =>
      process.stderr.write(`${line}
`),
    pid: process.pid,
    running: (target) => resumeRunning(cwd, target, issued, options),
  });
};
