// The OS sandbox a check step's command line runs in (ADR 0076): bwrap on Linux and WSL2,
// sandbox-exec on macOS, with no network, the home folder hidden and writes only in the worktree
// and a temporary folder. A repository's setup runs in the same sandbox with the network kept
// (ADR 0158), on Linux through a network namespace of its own that slirp4netns or pasta joins
// (ADR 0218). Native Windows has none (ADR 0010). A process runner that wraps another, so the
// deadline, the stop and the output limit stay the process runner's (ADR 0035).

import { mkdtempSync, readFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join, posix, resolve } from 'node:path';
import type { Duplex } from 'node:stream';
import { resolveExecutable } from './executables.ts';
import { pathInside, samePath } from './paths.ts';
import type { ExecOptions, ExecProcess, ExecResult } from './processes.ts';
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
 * The descriptors a setup's bwrap gets (ADR 0218): it writes its child's pid to the first, its
 * child waits for a byte on the second, and it reads the resolver's file from the third.
 */
const INFO_FD = 3;
const BLOCK_FD = 4;
const RESOLVER_FD = 5;

/**
 * The setup namespace's addresses under either stack (ADR 0218): its own, never the host's, the
 * stack's gateway, and the stack's resolver, which slirp4netns answers and pasta forwards to the
 * host's.
 */
const NAMESPACE_ADDRESS = '10.0.2.100';
const NAMESPACE_GATEWAY = '10.0.2.2';
const NAMESPACE_DNS = '10.0.2.3';

/**
 * A setup's /dev, without devpts (ADR 0218). For `--dev /dev`, bwrap maps the user to root in one
 * user namespace to mount devpts and nests a second one to map back, and the network namespace
 * belongs to the outer one, which no stack can join. So a setup has no pseudo-terminal.
 */
const SETUP_DEV = [
  ...['--tmpfs', '/dev'],
  ...['null', 'zero', 'full', 'random', 'urandom', 'tty'].flatMap((node) => [
    '--dev-bind',
    `/dev/${node}`,
    `/dev/${node}`,
  ]),
  ...['--tmpfs', '/dev/shm'],
  ...['--symlink', '/proc/self/fd', '/dev/fd'],
  ...['stdin', 'stdout', 'stderr'].flatMap((name, fd) => [
    '--symlink',
    `/proc/self/fd/${fd}`,
    `/dev/${name}`,
  ]),
];

/**
 * bwrap's arguments that run `line` through `/bin/sh` in the sandbox. With the network kept, a
 * network namespace of its own that a user-mode network stack joins once bwrap has told its
 * child's pid, the line waiting for it, a /dev without devpts, and the stack's resolver's file at
 * `resolver`, the real path of /etc/resolv.conf, read-only (ADR 0218).
 */
export function bwrapArgs(
  { home, worktree, gitDir, borrowed = [] }: CheckSandboxPaths,
  line: string,
  { network = false, resolver = RESOLV_CONF }: SandboxKeeps & { resolver?: string } = {},
): string[] {
  const fd = String;
  // In this order: bwrap applies its filesystem options as given, so the worktree goes over the
  // hidden home it may sit in.
  return [
    '--die-with-parent',
    '--unshare-pid',
    '--new-session',
    '--unshare-net',
    ...(network ? ['--info-fd', fd(INFO_FD), '--block-fd', fd(BLOCK_FD)] : []),
    ...['--ro-bind', '/', '/'],
    ...(network ? SETUP_DEV : ['--dev', '/dev']),
    ...['--proc', '/proc'],
    // /run holds the user's D-Bus socket, through which the Secret Service hands out logins.
    ...['--tmpfs', '/tmp', '--tmpfs', '/run', '--tmpfs', home],
    // After /run is hidden, so a link into it finds the file.
    ...(network ? ['--ro-bind-data', fd(RESOLVER_FD), resolver] : []),
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
  /**
   * Where a user-mode network stack is on the Cellar's PATH, or undefined (ADR 0218); default
   * `resolveExecutable`.
   */
  findStackTool?: (name: NetworkStackTool) => string | undefined;
}

/** The user-mode network stacks a Linux setup's namespace gets the network from (ADR 0218). */
export type NetworkStackTool = 'pasta' | 'slirp4netns';

/** In the order they are looked for: slirp4netns first, which Ubuntu lets into user namespaces. */
const stackTools: readonly NetworkStackTool[] = ['slirp4netns', 'pasta'];

/**
 * Where the setup's resolver's file goes: the real path of /etc/resolv.conf, which may link into
 * the hidden /run (systemd-resolved's stub), or the path itself when it cannot be resolved.
 */
const resolverIn = (realPath: (path: string) => string): string => {
  try {
    return realPath(RESOLV_CONF);
  } catch {
    // bwrap says so under its own name when it cannot put the file there.
    return RESOLV_CONF;
  }
};

/** What a check that could not start reads: no exit code, and why (ADR 0069's `unstarted`). */
const unstarted = (why: string, adr = '0076'): ExecResult => {
  const output = `${why} (ADR ${adr})\n`;
  return { exitCode: null, stdout: '', stderr: output, output };
};

/** The arguments that attach a stack to the namespace of `pid`, closed to the host (ADR 0218). */
const stackArgs = (tool: NetworkStackTool, pid: number): string[] => {
  switch (tool) {
    case 'pasta':
      // No gateway mapped to the host's loopback, and no port forwarded either way.
      return [
        ...['--config-net', '--quiet', '-4'],
        ...['-a', NAMESPACE_ADDRESS, '-n', '24', '-g', NAMESPACE_GATEWAY, '--no-map-gw'],
        ...['-t', 'none', '-u', 'none', '-T', 'none', '-U', 'none'],
        ...['--dns-forward', NAMESPACE_DNS],
        String(pid),
      ];
    case 'slirp4netns':
      return [
        ...['--configure', '--mtu=65520', '--disable-host-loopback'],
        ...['--ready-fd=3', '--exit-fd=4'],
        ...[String(pid), 'tap0'],
      ];
    default: {
      const never: never = tool;
      throw new Error(`no network stack ${String(never)}`);
    }
  }
};

/** The pid bwrap writes on its `--info-fd`, or undefined when it writes none it can be read by. */
const childPid = (info: Duplex): Promise<number | undefined> =>
  new Promise((done) => {
    let text = '';
    const answer = (pid: number | undefined) => {
      info.destroy();
      done(pid);
    };
    info.setEncoding('utf8').on('data', (chunk: string) => {
      text += chunk;
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        // Not all of it yet.
        return;
      }
      const pid = (parsed as { 'child-pid'?: unknown } | null)?.['child-pid'];
      answer(Number.isSafeInteger(pid) && (pid as number) > 0 ? (pid as number) : undefined);
    });
    info.once('end', () => answer(undefined));
    info.once('close', () => answer(undefined));
  });

/** What a stack that failed before it was up said, under its name. */
const stackFailure = (tool: NetworkStackTool, result: ExecResult): string => {
  const said = result.output.trim();
  const why =
    said !== ''
      ? said
      : result.killed !== undefined
        ? result.killed
        : `exit code ${result.exitCode}`;
  return why.startsWith(`${tool}: `) ? why : `${tool}: ${why}`;
};

/**
 * Starts the stack against `pid` and answers when it is up, with undefined, or with how it ended
 * when it ended first; `ended` answers when it has ended (ADR 0218). pasta forks to the
 * background once the namespace is configured; slirp4netns stays and says so on its ready pipe.
 */
const startStack = (
  exec: ExecProcess,
  stack: { tool: NetworkStackTool; path: string },
  pid: number,
  call: ExecOptions,
): { up: Promise<ExecResult | undefined>; ended: Promise<ExecResult> } => {
  const args = stackArgs(stack.tool, pid);
  const options: ExecOptions = {
    cwd: call.cwd,
    env: call.env,
    timeoutMs: call.timeoutMs,
    signal: call.signal,
  };
  if (stack.tool === 'pasta') {
    const ended = exec(stack.path, args, options);
    return { up: ended.then((result) => (result.exitCode === 0 ? undefined : result)), ended };
  }
  let ready: () => void = () => {};
  const isUp = new Promise<undefined>((done) => {
    ready = () => done(undefined);
  });
  // Its exit pipe stays open, and closes when the runner stops it or Foedrum ends.
  const pipes = {
    count: 2,
    onPipes: ([readyPipe]: readonly Duplex[]) => readyPipe?.once('data', ready),
  };
  const ended = exec(stack.path, args, { ...options, pipes });
  return { up: Promise.race([isUp, ended]), ended };
};

/**
 * A setup's line in bwrap with a network namespace of its own, which the stack joins before the
 * line runs, and which ends with bwrap (ADR 0218). A stack that fails before it is up stops bwrap
 * before the line runs, and the run reads `unstarted` with what it said.
 */
const inOwnNamespace = async (
  exec: ExecProcess,
  bwrap: string,
  stack: { tool: NetworkStackTool; path: string },
  args: string[],
  call: ExecOptions,
): Promise<ExecResult> => {
  const stopBwrap = new AbortController();
  const stopStack = new AbortController();
  const stoppedBy = (own: AbortSignal) =>
    call.signal === undefined ? own : AbortSignal.any([call.signal, own]);
  let failure: string | undefined;
  let attaching: Promise<unknown> = Promise.resolve();
  // Only while bwrap runs: a stack Foedrum stops once bwrap has ended, at its deadline too, did
  // not fail (review of #564).
  let bwrapEnded = false;
  const fail = (why: string) => {
    if (bwrapEnded) return;
    failure = why;
    stopBwrap.abort();
  };
  const attach = async ([info, block, data]: readonly Duplex[]) => {
    data?.end(`nameserver ${NAMESPACE_DNS}\n`);
    const pid = info === undefined ? undefined : await childPid(info);
    if (pid === undefined) {
      fail(`bwrap gave no child pid on its --info-fd`);
      return;
    }
    const run = startStack(exec, stack, pid, { ...call, signal: stoppedBy(stopStack.signal) });
    const failed = await run.up;
    if (failed === undefined) block?.end('1');
    else fail(stackFailure(stack.tool, failed));
    await run.ended;
  };
  const result = await exec(bwrap, args, {
    ...call,
    shell: false,
    signal: stoppedBy(stopBwrap.signal),
    pipes: {
      count: 3,
      onPipes: (pipes) => {
        attaching = attach(pipes);
      },
    },
  });
  bwrapEnded = true;
  stopStack.abort();
  await attaching;
  const own = sandboxRun('bwrap', result);
  if (own !== result || call.signal?.aborted === true) return own;
  if (failure === undefined) return result;
  // bwrap that failed under its own name says why, also when Foedrum stopped it for want of a
  // pid before the runner saw it end (review of #564).
  return result.stderr.startsWith('bwrap: ')
    ? unstarted(result.stderr.trim())
    : unstarted(failure, '0218');
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
  const findStackTool =
    options.findStackTool ?? ((tool: NetworkStackTool) => resolveExecutable(tool, { platform }));
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
      if (!network) {
        return sandboxRun(
          'bwrap',
          await exec(bwrap, bwrapArgs(paths, file), { ...call, shell: false }),
        );
      }
      const stack = stackTools
        .map((tool) => ({ tool, path: findStackTool(tool) }))
        .find(
          (found): found is { tool: NetworkStackTool; path: string } => found.path !== undefined,
        );
      if (stack === undefined) {
        return unstarted(
          "neither slirp4netns nor pasta (passt) is on PATH: a repository's setup runs only in a network namespace of its own here; install slirp4netns",
          '0218',
        );
      }
      const resolver = resolverIn(realPath);
      return inOwnNamespace(
        exec,
        bwrap,
        stack,
        bwrapArgs(paths, file, { network, resolver }),
        call,
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
