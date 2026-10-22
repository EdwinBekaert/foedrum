// The OS sandbox a check step's command line runs in (ADR 0076): bwrap on Linux and WSL2,
// sandbox-exec on macOS, with no network, the home folder hidden and writes only in the worktree
// and a temporary folder. Native Windows has none (ADR 0010). A process runner that wraps another,
// so the deadline, the stop and the output limit stay the process runner's (ADR 0035).

import { mkdtempSync, readFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { resolveExecutable } from './executables.ts';
import type { ExecProcess, ExecResult } from './processes.ts';
import { realPath as realPathOf } from './real-path.ts';
import { removeTree } from './remove.ts';

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
export const SEATBELT_PROFILE = [
  '(version 1)',
  '(allow default)',
  '(deny network*)',
  // The Keychain's service, where gh keeps its login on macOS (ADR 0073).
  '(deny mach-lookup (global-name "com.apple.SecurityServer"))',
  '(deny file-write*)',
  '(allow file-write* (subpath (param "WORKTREE")) (subpath (param "TEMP")) (literal "/dev/null"))',
  '(deny file-read* (subpath (param "HOME")))',
  // A later rule wins: the worktree and its repository may sit in the home folder.
  '(allow file-read* (subpath (param "WORKTREE")) (subpath (param "GIT_DIR")))',
  '',
].join('\n');

/** Where sandbox-exec is on macOS: by its full path, never looked up. */
export const SANDBOX_EXEC = '/usr/bin/sandbox-exec';

const throughSh = (line: string) => ['/bin/sh', '-c', line];

/** bwrap's arguments that run `line` through `/bin/sh` in the sandbox. */
export function bwrapArgs({ home, worktree, gitDir }: CheckSandboxPaths, line: string): string[] {
  // In this order: bwrap applies its filesystem options as given, so the worktree goes over the
  // hidden home it may sit in.
  return [
    '--die-with-parent',
    '--unshare-pid',
    '--new-session',
    '--unshare-net',
    ...['--ro-bind', '/', '/'],
    ...['--dev', '/dev', '--proc', '/proc'],
    // /run holds the user's D-Bus socket, through which the Secret Service hands out logins.
    ...['--tmpfs', '/tmp', '--tmpfs', '/run', '--tmpfs', home],
    ...(gitDir === undefined ? [] : ['--ro-bind', gitDir, gitDir]),
    ...['--bind', worktree, worktree, '--chdir', worktree],
    ...['--setenv', 'TMPDIR', '/tmp'],
    ...throughSh(line),
  ];
}

/** sandbox-exec's arguments that run `line` through `/bin/sh` under SEATBELT_PROFILE. */
export function seatbeltArgs(
  { home, worktree, gitDir, temp }: CheckSandboxPaths & { temp: string },
  line: string,
): string[] {
  // Parameters, never written into the profile, so no character in a path can change it.
  const parameters = { HOME: home, WORKTREE: worktree, GIT_DIR: gitDir ?? worktree, TEMP: temp };
  return [
    ...Object.entries(parameters).flatMap(([key, value]) => ['-D', `${key}=${value}`]),
    ...['-p', SEATBELT_PROFILE],
    ...throughSh(line),
  ];
}

/** A temporary folder per check on macOS: made before it, removed after it. */
export interface TempFolders {
  make: () => string;
  remove: (path: string) => Promise<void>;
}

const systemTemp: TempFolders = {
  make: () => mkdtempSync(join(tmpdir(), 'foedrum-check-')),
  remove: removeTree,
};

/**
 * The repository a worktree's `.git` file names: a linked worktree's record sits in
 * `<repository>/worktrees/<name>`, and git reads the repository too. Undefined without such a file.
 */
export const worktreeGitDir = (worktree: string): string | undefined => {
  let text: string;
  try {
    text = readFileSync(join(worktree, '.git'), 'utf8');
  } catch {
    // No file, or a folder: a repository inside the worktree, which is bound anyway.
    return undefined;
  }
  const named = /^gitdir: (.+)$/m.exec(text)?.[1]?.trim();
  if (named === undefined) return undefined;
  const record = isAbsolute(named) ? named : resolve(worktree, named);
  return basename(dirname(record)) === 'worktrees' ? dirname(dirname(record)) : record;
};

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

/** What a check that could not start reads: no exit code, and why (ADR 0069's `unstarted`). */
const unstarted = (why: string): ExecResult => {
  const output = `${why} (ADR 0076)\n`;
  return { exitCode: null, stdout: '', stderr: output, output };
};

/**
 * A process runner that starts each command line (`shell: true`) in the check sandbox of the
 * platform, and every other call as `exec` would. On native Windows a line runs as before.
 */
export function sandboxedChecks(options: SandboxedChecksOptions): ExecProcess {
  const { exec, platform = process.platform, realPath = realPathOf } = options;
  const { gitDirOf = worktreeGitDir, temp = systemTemp } = options;
  const findBwrap = options.findBwrap ?? (() => resolveExecutable('bwrap', { platform }));
  const hasSandboxExec =
    options.hasSandboxExec ?? (() => resolveExecutable(SANDBOX_EXEC, { platform }) !== undefined);
  return async (file, args, call) => {
    if (call.shell !== true || platform === 'win32') return exec(file, args, call);
    const gitDir = gitDirOf(call.cwd);
    const paths: CheckSandboxPaths = {
      home: realPath(options.home ?? homedir()),
      worktree: realPath(call.cwd),
      gitDir: gitDir === undefined ? undefined : realPath(gitDir),
    };
    // Never unsandboxed outside Windows: a check that cannot have its sandbox does not run.
    if (platform !== 'darwin') {
      const bwrap = findBwrap();
      if (bwrap === undefined) {
        return unstarted(
          'bubblewrap (bwrap) is not on PATH: check steps run only in its sandbox here; install bubblewrap',
        );
      }
      return exec(bwrap, bwrapArgs(paths, file), { ...call, shell: false });
    }
    if (!hasSandboxExec()) {
      return unstarted(`${SANDBOX_EXEC} is not there: check steps run only in its sandbox here`);
    }
    const folder = temp.make();
    try {
      const real = realPath(folder);
      // An empty home the check may write, as bwrap's hidden one is.
      const env = { ...(call.env ?? process.env), TMPDIR: real, HOME: real };
      return await exec(SANDBOX_EXEC, seatbeltArgs({ ...paths, temp: real }, file), {
        ...call,
        env,
        shell: false,
      });
    } finally {
      await temp.remove(folder);
    }
  };
}
