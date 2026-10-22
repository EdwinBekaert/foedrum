// The OS sandbox a check step's command line runs in (ADR 0076): bwrap on Linux and WSL2,
// sandbox-exec on macOS, with no network, the home folder hidden and writes only in the worktree
// and a temporary folder. Native Windows has none (ADR 0010). A process runner that wraps another,
// so the deadline, the stop and the output limit stay the process runner's (ADR 0035).

import type { ExecProcess } from './processes.ts';

/** The paths a check's sandbox is built from, all real paths. */
export interface CheckSandboxPaths {
  /** The home folder, hidden. */
  home: string;
  /** The attempt's worktree: the only folder the check writes, besides a temporary one. */
  worktree: string;
  /** The repository the worktree's `.git` file names, read-only; undefined when it names none. */
  gitDir: string | undefined;
}

/** The profile every check runs under on macOS; its paths come as parameters (`-D`). */
export const SEATBELT_PROFILE = '';

/** Where sandbox-exec is on macOS: by its full path, never looked up. */
export const SANDBOX_EXEC = '/usr/bin/sandbox-exec';

/** bwrap's arguments that run `line` through `/bin/sh` in the sandbox. */
export function bwrapArgs(_paths: CheckSandboxPaths, _line: string): string[] {
  throw new Error('not implemented');
}

/** sandbox-exec's arguments that run `line` through `/bin/sh` under SEATBELT_PROFILE. */
export function seatbeltArgs(
  _paths: CheckSandboxPaths & { temp: string },
  _line: string,
): string[] {
  throw new Error('not implemented');
}

/** A temporary folder per check on macOS: made before it, removed after it. */
export interface TempFolders {
  make: () => string;
  remove: (path: string) => Promise<void>;
}

export interface SandboxedChecksOptions {
  /** The process runner the sandbox is started through. */
  exec: ExecProcess;
  /** Default this process's. */
  platform?: NodeJS.Platform;
  /** Default `os.homedir()`. */
  home?: string;
  /** bwrap's path, or undefined when it is not on the Cellar's PATH. */
  findBwrap?: () => string | undefined;
  /** Whether sandbox-exec is at SANDBOX_EXEC. */
  hasSandboxExec?: () => boolean;
  /** Default `realPath`. */
  realPath?: (path: string) => string;
  /** The repository a worktree's `.git` file names, or undefined. */
  gitDirOf?: (worktree: string) => string | undefined;
  /** Default folders under `os.tmpdir()`. */
  temp?: TempFolders;
}

/**
 * A process runner that starts each command line (`shell: true`) in the check sandbox of the
 * platform, and every other call as `exec` would. On native Windows a line runs as before.
 */
export function sandboxedChecks(_options: SandboxedChecksOptions): ExecProcess {
  throw new Error('not implemented');
}
