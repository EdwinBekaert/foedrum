// Runs git for Foedrum: non-interactive, with a timeout, through an argument array (architecture
// §13). Code that drives git takes a `Git` so unit tests can pass a fake one (ADR 0021).

import { spawn } from 'node:child_process';
import { killableSpawnOptions, killProcessTree } from '../platform/processes.ts';

export interface GitResult {
  /** The exit code; `null` when git was killed, for example by the timeout. */
  code: number | null;
  stdout: string;
  stderr: string;
}

export interface GitOptions {
  /** Kills git after this long; default 60 s. */
  timeoutMs?: number;
  /** Configuration for this call only, given through the environment (`GIT_CONFIG_COUNT`). */
  config?: Readonly<Record<string, string>>;
}

export type Git = (
  cwd: string,
  args: readonly string[],
  options?: GitOptions,
) => Promise<GitResult>;

/**
 * The environment git runs in: it never prompts, in the terminal or through Git Credential
 * Manager's window; a missing credential makes the command fail instead. The user's ssh choice
 * (GIT_SSH, core.sshCommand) stays: without a terminal, ssh cannot prompt either.
 */
export const gitEnv = (
  env: NodeJS.ProcessEnv,
  config: Readonly<Record<string, string>> = {},
): NodeJS.ProcessEnv => {
  // core.longpaths, then the call's own configuration, after any configuration the environment
  // already gives git: out docs on the state branch can be deeper than Windows' 260 characters
  // (ADR 0024).
  const count = Number.parseInt(env.GIT_CONFIG_COUNT ?? '0', 10) || 0;
  const entries = [['core.longpaths', 'true'], ...Object.entries(config)];
  const added: NodeJS.ProcessEnv = {};
  entries.forEach(([key, value], i) => {
    added[`GIT_CONFIG_KEY_${count + i}`] = key;
    added[`GIT_CONFIG_VALUE_${count + i}`] = value;
  });
  return {
    ...env,
    GIT_TERMINAL_PROMPT: '0',
    GCM_INTERACTIVE: 'never',
    GIT_CONFIG_COUNT: String(count + entries.length),
    ...added,
  };
};

/**
 * The real git. The timeout is a hard deadline: it kills git and every process git started (a
 * credential helper, ssh, gpg) and answers at once, without waiting for their output to close.
 */
export const runGit: Git = (cwd, args, { timeoutMs = 60_000, config } = {}) =>
  new Promise((done) => {
    let stdout = '';
    let stderr = '';
    let finished = false;
    const finish = (result: GitResult): void => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      done(result);
    };
    // spawn rather than execFile, still with an argument array and no shell: execFile answers
    // only once every output pipe closes, which a surviving child of git can hold off forever.
    const child = spawn('git', [...args], {
      cwd,
      env: gitEnv(process.env, config),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      ...killableSpawnOptions(),
    });
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      stderr += chunk;
    });
    const timer = setTimeout(() => {
      if (child.pid !== undefined) killProcessTree(child.pid);
      child.stdout.destroy();
      child.stderr.destroy();
      finish({ code: null, stdout, stderr: `${stderr}git timed out after ${timeoutMs} ms` });
    }, timeoutMs);
    // A git that cannot start (not installed) has no exit code either.
    child.on('error', (error) => finish({ code: null, stdout, stderr: stderr || error.message }));
    child.on('close', (code) => finish({ code, stdout, stderr }));
  });
