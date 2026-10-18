// Runs git for Foedrum: non-interactive, with a timeout, through an argument array (architecture
// §13). Code that drives git takes a `Git` so unit tests can pass a fake one (ADR 0021).

import { type ExecProcess, execProcess, type Killed, whyKilled } from '../platform/processes.ts';

export interface GitResult {
  /** The exit code; `null` when git was killed, for example by the timeout or the output limit. */
  code: number | null;
  stdout: string;
  stderr: string;
}

export interface GitOptions {
  /** Kills git after this long; default 60 s. */
  timeoutMs?: number;
  /** Configuration for this call only, given through the environment (`GIT_CONFIG_COUNT`). */
  config?: Readonly<Record<string, string>>;
  /** Kills git and every process it started when it aborts. */
  signal?: AbortSignal;
  /** Kills git when its output passes this many bytes; default the runner's 4 MiB (ADR 0035). */
  maxOutputBytes?: number;
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
  _platform: NodeJS.Platform = process.platform,
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

// Why the runner killed git, for its stderr; nothing for a stop, which the caller asked for.
const whyGitKilled = (
  killed: Killed | undefined,
  timeoutMs: number,
  maxOutputBytes: number | undefined,
): string => {
  switch (killed) {
    case undefined:
    case 'stopped':
      return '';
    case 'timed-out':
      return `git timed out after ${timeoutMs} ms`;
    case 'too-much-output':
      return `git ${whyKilled(killed, timeoutMs, maxOutputBytes)}`;
    default: {
      const unknown: never = killed;
      throw new Error(`unknown kill ${String(unknown)}`);
    }
  }
};

/** git through the given process runner; unit tests pass a fake one (ADR 0021). */
export const runGitWith =
  (exec: ExecProcess): Git =>
  async (cwd, args, { timeoutMs = 60_000, config, signal, maxOutputBytes } = {}) => {
    const { exitCode, stdout, stderr, killed } = await exec('git', args, {
      cwd,
      env: gitEnv(process.env, config),
      timeoutMs,
      signal,
      maxOutputBytes,
    });
    const why = whyGitKilled(killed, timeoutMs, maxOutputBytes);
    return { code: exitCode, stdout, stderr: `${stderr}${why}` };
  };

/**
 * The real git, through the platform's process runner. The timeout is a hard deadline: it kills
 * git and every process git started (a credential helper, ssh, gpg) and answers at once, without
 * waiting for their output to close. A git that cannot start (not installed) has no exit code
 * either.
 */
export const runGit: Git = runGitWith(execProcess);
