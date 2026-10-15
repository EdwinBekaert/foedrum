// Runs git for Foedrum: non-interactive, with a timeout, through an argument array (architecture
// §13). Code that drives git takes a `Git` so unit tests can pass a fake one (ADR 0021).

import { execFile } from 'node:child_process';

export interface GitResult {
  /** The exit code; `null` when git was killed, for example by the timeout. */
  code: number | null;
  stdout: string;
  stderr: string;
}

export interface GitOptions {
  /** Kills git after this long; default 60 s. */
  timeoutMs?: number;
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
export const gitEnv = (env: NodeJS.ProcessEnv): NodeJS.ProcessEnv => {
  // core.longpaths, added after any configuration the environment already gives git: out docs
  // on the state branch can be deeper than Windows' 260 characters (ADR 0024).
  const count = Number.parseInt(env.GIT_CONFIG_COUNT ?? '0', 10) || 0;
  return {
    ...env,
    GIT_TERMINAL_PROMPT: '0',
    GCM_INTERACTIVE: 'never',
    GIT_CONFIG_COUNT: String(count + 1),
    [`GIT_CONFIG_KEY_${count}`]: 'core.longpaths',
    [`GIT_CONFIG_VALUE_${count}`]: 'true',
  };
};

/** The real git. */
export const runGit: Git = (cwd, args, { timeoutMs = 60_000 } = {}) =>
  new Promise((done) => {
    const options = {
      cwd,
      encoding: 'utf8',
      timeout: timeoutMs,
      windowsHide: true,
      maxBuffer: 64 * 1024 * 1024,
      env: gitEnv(process.env),
    } as const;
    execFile('git', [...args], options, (error, stdout, stderr) => {
      // A number is git's exit code; a killed git (timeout) has none, nor has a missing one.
      const code = error === null ? 0 : typeof error.code === 'number' ? error.code : null;
      done({ code, stdout, stderr: stderr || (error?.message ?? '') });
    });
  });
