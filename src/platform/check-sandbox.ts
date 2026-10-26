// The OS sandbox a check step's command line runs in (ADR 0076): bwrap on Linux and WSL2,
// sandbox-exec on macOS, with no network, the home folder hidden and writes only in the worktree
// and a temporary folder. A repository's setup runs in the same sandbox with the network kept
// (ADR 0158). Native Windows has none (ADR 0010). A process runner that wraps another, so the
// deadline, the stop and the output limit stay the process runner's (ADR 0035).

import { mkdtempSync, readFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join, posix, resolve } from 'node:path';
import { resolveExecutable } from './executables.ts';
import { pathInside, samePath } from './paths.ts';
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
  /**
   * The object stores that repository borrows through its alternates, read-only: the clone's, for a
   * worktree of Foedrum's own git directory (ADR 0203).
   */
  borrowed?: readonly string[];
}

/** What a sandbox keeps of the machine beyond a check's: the network, for a setup (ADR 0158). */
interface SandboxKeeps {
  network?: boolean;
}

/** How many object stores the worktree's repository borrows, each a `BORROWED_<n>` (ADR 0203). */
interface Borrowed {
  borrowed?: number;
}

/**
 * The profile every check runs under on macOS, its paths given as parameters (`-D`): `parents`
 * folders above the worktree and its repository in the home folder, as `PARENT_<n>`, whose
 * metadata a check may read, since node stats each folder above a file it loads (ADR 0142).
 * Without its denial of the network for a setup (ADR 0158).
 */
export const seatbeltProfile = (
  parents: number,
  { network = false, borrowed = 0 }: SandboxKeeps & Borrowed = {},
): string => {
  const stores = Array.from({ length: borrowed }, (_, n) => ` (subpath (param "BORROWED_${n}"))`);
  const literals = Array.from({ length: parents }, (_, n) => `(literal (param "PARENT_${n}"))`);
  return [
    '(version 1)',
    '(allow default)',
    // network* covers Unix sockets too, such as launchd's ssh-agent under /private/tmp: a setup
    // keeps IP and the resolver's socket only (review of #422).
    ...(network
      ? [
          '(deny network-outbound (remote unix-socket))',
          '(allow network-outbound (remote unix-socket (path-literal "/private/var/run/mDNSResponder")))',
        ]
      : ['(deny network*)']),
    // The Keychain's service, where gh keeps its login on macOS (ADR 0073).
    '(deny mach-lookup (global-name "com.apple.SecurityServer"))',
    // launchd and LaunchServices start what they are asked to outside the sandbox (review of #357).
    '(deny job-creation)',
    '(deny lsopen)',
    '(deny appleevent-send)',
    '(deny mach-lookup (global-name "com.apple.coreservices.launchservicesd"))',
    '(deny file-write*)',
    // Its output and terminal too, as bwrap's own /dev allows.
    '(allow file-write* (subpath (param "WORKTREE")) (subpath (param "TEMP")) (literal "/dev/null") (literal "/dev/stdout") (literal "/dev/stderr") (literal "/dev/tty") (regex #"^/dev/fd/"))',
    '(deny file-read* (subpath (param "HOME")))',
    // A later rule wins: the worktree and its repository may sit in the home folder.
    ...(parents === 0 ? [] : [`(allow file-read-metadata ${literals.join(' ')})`]),
    '(allow file-read* (subpath (param "WORKTREE")) (subpath (param "GIT_DIR")))',
    ...(borrowed === 0 ? [] : [`(allow file-read*${stores.join('')})`]),
    '',
  ].join('\n');
};

/** The folders from `home` down to each of `paths`, each once; none for a path outside it. */
const foldersAbove = (home: string, paths: readonly string[]): string[] => {
  const inHome = (folder: string) => {
    const path = posix.relative(home, folder);
    return path !== '..' && !path.startsWith('../');
  };
  const folders = new Set<string>();
  for (const path of paths) {
    const above: string[] = [];
    for (let folder = posix.dirname(path); inHome(folder); folder = posix.dirname(folder)) {
      above.unshift(folder);
      if (folder === posix.dirname(folder)) break;
    }
    for (const folder of above) folders.add(folder);
  }
  return [...folders];
};

/** Whether check steps run without an OS sandbox here: on native Windows only (ADR 0010). */
export const checksRunUnsandboxed = (platform: NodeJS.Platform): boolean => platform === 'win32';

/** Where sandbox-exec is on macOS: by its full path, never looked up. */
export const SANDBOX_EXEC = '/usr/bin/sandbox-exec';

const throughSh = (line: string) => ['/bin/sh', '-c', line];

/** Where Linux keeps the resolver's address list, often a link into /run. */
const RESOLV_CONF = '/etc/resolv.conf';

/**
 * bwrap's arguments that run `line` through `/bin/sh` in the sandbox. With the network kept, no
 * namespace of its own, and `resolver`, the real path of /etc/resolv.conf when it is under the
 * hidden /run (systemd-resolved's stub), bound back read-only, the one file (ADR 0158).
 */
export function bwrapArgs(
  { home, worktree, gitDir, borrowed = [] }: CheckSandboxPaths,
  line: string,
  { network = false, resolver }: SandboxKeeps & { resolver?: string | undefined } = {},
): string[] {
  // In this order: bwrap applies its filesystem options as given, so the worktree goes over the
  // hidden home it may sit in.
  return [
    '--die-with-parent',
    '--unshare-pid',
    '--new-session',
    ...(network ? [] : ['--unshare-net']),
    ...['--ro-bind', '/', '/'],
    ...['--dev', '/dev', '--proc', '/proc'],
    // /run holds the user's D-Bus socket, through which the Secret Service hands out logins.
    ...['--tmpfs', '/tmp', '--tmpfs', '/run', '--tmpfs', home],
    ...(network && resolver !== undefined ? ['--ro-bind', resolver, resolver] : []),
    ...(gitDir === undefined ? [] : ['--ro-bind', gitDir, gitDir]),
    ...borrowed.flatMap((store) => ['--ro-bind', store, store]),
    ...['--bind', worktree, worktree, '--chdir', worktree],
    ...['--setenv', 'TMPDIR', '/tmp'],
    ...throughSh(line),
  ];
}

/** sandbox-exec's arguments that run `line` through `/bin/sh` under `seatbeltProfile`. */
export function seatbeltArgs(
  { home, worktree, gitDir, borrowed = [], temp }: CheckSandboxPaths & { temp: string },
  line: string,
  keeps: SandboxKeeps = {},
): string[] {
  // Parameters, never written into the profile, so no character in a path can change it.
  const parameters = { HOME: home, WORKTREE: worktree, GIT_DIR: gitDir ?? worktree, TEMP: temp };
  const parents = foldersAbove(home, [
    worktree,
    ...(gitDir === undefined ? [] : [gitDir]),
    ...borrowed,
  ]);
  return [
    ...Object.entries(parameters).flatMap(([key, value]) => ['-D', `${key}=${value}`]),
    ...borrowed.flatMap((store, n) => ['-D', `BORROWED_${n}=${store}`]),
    ...parents.flatMap((folder, n) => ['-D', `PARENT_${n}=${folder}`]),
    ...['-p', seatbeltProfile(parents.length, { ...keeps, borrowed: borrowed.length })],
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
 * `<repository>/worktrees/<name>`, and git reads the repository too. Only when that record's
 * `gitdir` file names the worktree's `.git` back: a check writes its worktree, `.git` included, and
 * must not name the home folder or /run for a later check's sandbox to let in (review of #357).
 * Undefined otherwise.
 */
export const worktreeGitDir = (worktree: string): string | undefined => {
  try {
    const text = readFileSync(join(worktree, '.git'), 'utf8');
    const named = /^gitdir: (.+)$/m.exec(text)?.[1]?.trim();
    if (named === undefined) return undefined;
    const record = resolve(worktree, named);
    if (basename(dirname(record)) !== 'worktrees') return undefined;
    // Written by git outside the worktree, where no check writes.
    const back = readFileSync(join(record, 'gitdir'), 'utf8').trim();
    // As real paths: git records the real one, serve may name the worktree through a link.
    const same = samePath(realPathOf(resolve(record, back)), realPathOf(join(worktree, '.git')));
    return same ? dirname(dirname(record)) : undefined;
  } catch {
    // No file, or a folder: a repository inside the worktree, which is bound anyway.
    return undefined;
  }
};

/**
 * The object stores a repository's `objects/info/alternates` names, a relative one against its
 * `objects` (ADR 0203); none without the file.
 */
export const borrowedStores = (repository: string): string[] => {
  const objects = join(repository, 'objects');
  let text: string;
  try {
    text = readFileSync(join(objects, 'info', 'alternates'), 'utf8');
  } catch {
    // None: the repository has its own objects only.
    return [];
  }
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'))
    .map((line) => resolve(objects, line));
};

/**
 * Whether a repository's real path is a `.git` directory directly in one of `roots`, each read by
 * its real path, for `borrowsFrom` (ADR 0203): Foedrum's own git directories. Nothing deeper
 * holds, since a merged tree's worktree, `<uuid>.tree` beside its directory, is its check's to
 * write (review of #528).
 */
export const insideFolders =
  (roots: readonly string[], realPath: (path: string) => string) =>
  (realRepository: string): boolean =>
    basename(realRepository).endsWith('.git') &&
    roots.some((root) => samePath(dirname(realRepository), realPath(root)));

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
  /** The object stores a repository borrows; default `borrowedStores`. */
  borrowedOf?: (repository: string) => readonly string[];
  /**
   * Whether the sandbox binds the stores the repository at this real path borrows: one in a folder
   * Foedrum alone writes (ADR 0203). Default none.
   */
  borrowsFrom?: (realRepository: string) => boolean;
  /** Default folders under `os.tmpdir()`. */
  temp?: TempFolders;
  /** Whether the sandbox keeps the network, as a repository's setup needs (ADR 0158). */
  network?: boolean;
}

/** The real path of /etc/resolv.conf when it lies under /run, which the sandbox hides. */
const resolverIn = (realPath: (path: string) => string): string | undefined => {
  try {
    const real = realPath(RESOLV_CONF);
    return real.startsWith('/run/') ? real : undefined;
  } catch {
    // No resolver's file: the install finds no address, and says so.
    return undefined;
  }
};

/** What a check that could not start reads: no exit code, and why (ADR 0069's `unstarted`). */
const unstarted = (why: string): ExecResult => {
  const output = `${why} (ADR 0076)\n`;
  return { exitCode: null, stdout: '', stderr: output, output };
};

/**
 * The run of a sandbox, read as a check that could not start when the sandbox itself failed:
 * bwrap and sandbox-exec name themselves at the start of what they write then, before the
 * command line runs.
 */
const sandboxRun = (tool: string, result: ExecResult): ExecResult =>
  result.killed === undefined &&
  result.signal === undefined &&
  result.exitCode !== null &&
  result.exitCode !== 0 &&
  result.stderr.startsWith(`${tool}: `)
    ? unstarted(result.stderr.trim())
    : result;

/**
 * A process runner that starts each command line (`shell: true`) in the check sandbox of the
 * platform, and every other call as `exec` would. On native Windows a line runs as before.
 */
export function sandboxedChecks(options: SandboxedChecksOptions): ExecProcess {
  const { exec, platform = process.platform, realPath = realPathOf } = options;
  const { gitDirOf = worktreeGitDir, temp = systemTemp, network = false } = options;
  const { borrowedOf = borrowedStores, borrowsFrom = () => false } = options;
  const findBwrap = options.findBwrap ?? (() => resolveExecutable('bwrap', { platform }));
  const hasSandboxExec =
    options.hasSandboxExec ?? (() => resolveExecutable(SANDBOX_EXEC, { platform }) !== undefined);
  return async (file, args, call) => {
    if (call.shell !== true || checksRunUnsandboxed(platform)) return exec(file, args, call);
    // Never unsandboxed outside Windows: a check that cannot have its sandbox does not run.
    let paths: CheckSandboxPaths;
    try {
      const gitDir = gitDirOf(call.cwd);
      const worktree = realPath(call.cwd);
      const repository = gitDir === undefined ? undefined : realPath(gitDir);
      // Only a repository in a folder Foedrum alone writes names what it borrows: a brewer or a
      // check writes its worktree, and could plant a record and an alternates file there or in a
      // sibling attempt's (review of #528).
      const borrows = repository !== undefined && borrowsFrom(repository);
      paths = {
        home: realPath(options.home ?? homedir()),
        worktree,
        gitDir: repository,
        borrowed: borrows ? borrowedOf(repository).map((store) => realPath(store)) : [],
      };
    } catch (error) {
      return unstarted(`the check's sandbox cannot be set up: ${messageOf(error)}`);
    }
    if (platform !== 'darwin') {
      const bwrap = findBwrap();
      if (bwrap === undefined) {
        return unstarted(
          'bubblewrap (bwrap) is not on PATH: check steps run only in its sandbox here; install bubblewrap',
        );
      }
      const resolver = network ? resolverIn(realPath) : undefined;
      return sandboxRun(
        'bwrap',
        await exec(bwrap, bwrapArgs(paths, file, { network, resolver }), { ...call, shell: false }),
      );
    }
    if (!hasSandboxExec()) {
      return unstarted(`${SANDBOX_EXEC} is not there: check steps run only in its sandbox here`);
    }
    let folder: string;
    try {
      folder = temp.make();
    } catch (error) {
      return unstarted(`the check's temporary folder cannot be made: ${messageOf(error)}`);
    }
    // A folder the check made hard to remove leaves its result as it is, with a line about it.
    const removed = async (result: ExecResult): Promise<ExecResult> => {
      try {
        await temp.remove(folder);
        return result;
      } catch (error) {
        const line = `foedrum: the check's temporary folder ${folder} was left: ${messageOf(error)}\n`;
        return { ...result, stderr: `${result.stderr}${line}`, output: `${result.output}${line}` };
      }
    };
    let real: string;
    try {
      real = realPath(folder);
    } catch (error) {
      return removed(unstarted(`the check's sandbox cannot be set up: ${messageOf(error)}`));
    }
    // An empty home the check may write, as bwrap's hidden one is.
    const env = { ...(call.env ?? process.env), TMPDIR: real, HOME: real };
    let result: ExecResult;
    try {
      const args = seatbeltArgs({ ...paths, temp: real }, file, { network });
      result = await exec(SANDBOX_EXEC, args, { ...call, env, shell: false });
    } catch (error) {
      await removed({ exitCode: null, stdout: '', stderr: '', output: '' });
      throw error;
    }
    return removed(sandboxRun('sandbox-exec', result));
  };
}

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
