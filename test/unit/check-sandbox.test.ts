// The check sandbox (ADR 0076): a check's command line starts through bwrap on Linux and
// sandbox-exec on macOS with exactly these arguments, and as before on native Windows. A fake
// process runner records what would start (ADR 0021); whether the tools work is theirs.

import assert from 'node:assert/strict';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { type Duplex, PassThrough } from 'node:stream';
import { describe, it } from 'node:test';
import {
  borrowedStores,
  insideFolders,
  type NetworkStackTool,
  SANDBOX_EXEC,
  type SandboxedChecksOptions,
  sandboxedChecks,
  seatbeltProfile,
  worktreeGitDir,
} from '../../src/platform/check-sandbox.ts';
import type { ExecOptions, ExecProcess, ExecResult } from '../../src/platform/processes.ts';
import { makeTempDir } from '../helpers/temp-dir.ts';

const home = '/home/ada';
const worktree = '/home/ada/.foedrum/acme/attempts/12-1/green/1';
const gitDir = '/home/ada/.foedrum/acme/clones/acme.api/.git';
const line = 'npm test -- --reporter tap';
const env = { PATH: '/usr/bin', TMPDIR: '/var/tmp/ada' };
const signal = new AbortController().signal;
const call: ExecOptions = {
  cwd: worktree,
  env,
  timeoutMs: 60_000,
  signal,
  shell: true,
  jobObject: true,
  maxOutputBytes: 1024,
};

const fake = (answer: Partial<ExecResult> = {}) => {
  const calls: { file: string; args: readonly string[]; options: ExecOptions }[] = [];
  const exec: ExecProcess = async (file, args, options) => {
    calls.push({ file, args, options });
    return { exitCode: 0, stdout: '', stderr: '', output: '', ...answer };
  };
  return { calls, exec };
};

const options = (exec: ExecProcess, more: Partial<SandboxedChecksOptions> = {}) => ({
  exec,
  home,
  findBwrap: () => '/usr/bin/bwrap',
  hasSandboxExec: () => true,
  // No user-mode network stack unless a test gives one (ADR 0218).
  findStackTool: () => undefined,
  realPath: (path: string) => path,
  gitDirOf: (path: string) => (path === worktree ? gitDir : undefined),
  ...more,
});

describe('sandboxedChecks on Linux and WSL2: bwrap', () => {
  it('starts the line through /bin/sh in bwrap, with no network, the home hidden and the worktree writable', async () => {
    const { calls, exec } = fake({ exitCode: 3, output: 'not ok 1\n' });
    const run = sandboxedChecks(options(exec, { platform: 'linux' }));
    const result = await run(line, [], call);
    assert.equal(result.exitCode, 3);
    assert.deepEqual(calls, [
      {
        file: '/usr/bin/bwrap',
        args: [
          '--die-with-parent',
          '--unshare-pid',
          '--new-session',
          '--unshare-net',
          '--ro-bind',
          '/',
          '/',
          '--dev',
          '/dev',
          '--proc',
          '/proc',
          '--tmpfs',
          '/tmp',
          '--tmpfs',
          '/run',
          '--tmpfs',
          home,
          '--ro-bind',
          gitDir,
          gitDir,
          '--bind',
          worktree,
          worktree,
          '--chdir',
          worktree,
          '--setenv',
          'TMPDIR',
          '/tmp',
          '/bin/sh',
          '-c',
          line,
        ],
        // The process runner's deadline, stop and limit as the caller gave them; no shell.
        options: { ...call, shell: false },
      },
    ]);
  });

  it('binds no repository when the worktree names none', async () => {
    const { calls, exec } = fake();
    const run = sandboxedChecks(options(exec, { platform: 'linux', gitDirOf: () => undefined }));
    await run(line, [], call);
    assert.ok(!calls[0]?.args.includes(gitDir));
    assert.deepEqual(calls[0]?.args.slice(15, 21), [
      '--tmpfs',
      home,
      '--bind',
      worktree,
      worktree,
      '--chdir',
    ]);
  });

  it('binds the real paths of the home, the repository and the worktree', async () => {
    const { calls, exec } = fake();
    const real = (path: string) => `/real${path}`;
    const run = sandboxedChecks(options(exec, { platform: 'linux', realPath: real }));
    await run(line, [], call);
    const args = calls[0]?.args ?? [];
    assert.deepEqual(args.slice(15, 26), [
      '--tmpfs',
      `/real${home}`,
      '--ro-bind',
      `/real${gitDir}`,
      `/real${gitDir}`,
      '--bind',
      `/real${worktree}`,
      `/real${worktree}`,
      '--chdir',
      `/real${worktree}`,
      '--setenv',
    ]);
  });

  it('reads a bwrap that could not make its sandbox as a check that could not start, with its message', async () => {
    const stderr = 'bwrap: setting up uid map: Permission denied\n';
    const { exec } = fake({ exitCode: 1, stderr, output: stderr });
    const run = sandboxedChecks(options(exec, { platform: 'linux' }));
    const result = await run(line, [], call);
    assert.equal(result.exitCode, null);
    assert.equal(result.killed, undefined);
    assert.match(result.output, /bwrap: setting up uid map: Permission denied/);
  });

  it('keeps a run the process runner killed as killed, whatever it printed', async () => {
    const stderr = 'bwrap: something\n';
    const { exec } = fake({ exitCode: 1, stderr, output: stderr, killed: 'timed-out' });
    const run = sandboxedChecks(options(exec, { platform: 'linux' }));
    const result = await run(line, [], call);
    assert.equal(result.killed, 'timed-out');
    assert.equal(result.exitCode, 1);
  });

  it("keeps a check's own failure, whatever it prints", async () => {
    const output = 'not ok 1 - bwrap: not mentioned first\n';
    const { exec } = fake({ exitCode: 1, stdout: output, output });
    const run = sandboxedChecks(options(exec, { platform: 'linux' }));
    assert.equal((await run(line, [], call)).exitCode, 1);
  });

  it('does not run the line when a path cannot be resolved: it could not start, and says why', async () => {
    const { calls, exec } = fake();
    const realPath = (): string => {
      throw new Error('EACCES: permission denied');
    };
    const run = sandboxedChecks(options(exec, { platform: 'linux', realPath }));
    const result = await run(line, [], call);
    assert.deepEqual(calls, []);
    assert.equal(result.exitCode, null);
    assert.match(result.output, /EACCES/);
  });

  it('does not run the line without bwrap: it could not start, and says why', async () => {
    const { calls, exec } = fake();
    const run = sandboxedChecks(options(exec, { platform: 'linux', findBwrap: () => undefined }));
    const result = await run(line, [], call);
    assert.deepEqual(calls, []);
    assert.equal(result.exitCode, null);
    assert.equal(result.killed, undefined);
    assert.match(result.output, /bubblewrap \(bwrap\) is not on PATH.*\(ADR 0076\)/);
  });
});

describe('sandboxedChecks on macOS: sandbox-exec', () => {
  const temp = '/private/var/folders/x/T/foedrum-check-1';
  // node stats each folder above a file it loads, in the home folder too (#376).
  const parents = [
    home,
    '/home/ada/.foedrum',
    '/home/ada/.foedrum/acme',
    '/home/ada/.foedrum/acme/attempts',
    '/home/ada/.foedrum/acme/attempts/12-1',
    '/home/ada/.foedrum/acme/attempts/12-1/green',
    '/home/ada/.foedrum/acme/clones',
    '/home/ada/.foedrum/acme/clones/acme.api',
  ];
  const folders = () => {
    const removed: string[] = [];
    return {
      removed,
      temp: {
        make: () => temp,
        remove: async (path: string) => {
          removed.push(path);
        },
      },
    };
  };

  it('starts the line through /bin/sh under the profile, the paths as parameters, in a temporary home', async () => {
    const { calls, exec } = fake();
    const { removed, temp: made } = folders();
    const run = sandboxedChecks(options(exec, { platform: 'darwin', temp: made }));
    await run(line, [], call);
    assert.deepEqual(calls, [
      {
        file: SANDBOX_EXEC,
        args: [
          '-D',
          `HOME=${home}`,
          '-D',
          `WORKTREE=${worktree}`,
          '-D',
          `GIT_DIR=${gitDir}`,
          '-D',
          `TEMP=${temp}`,
          ...parents.flatMap((folder, n) => ['-D', `PARENT_${n}=${folder}`]),
          '-p',
          seatbeltProfile(parents.length),
          '/bin/sh',
          '-c',
          line,
        ],
        options: { ...call, shell: false, env: { ...env, TMPDIR: temp, HOME: temp } },
      },
    ]);
    assert.deepEqual(removed, [temp]);
  });

  it('names no folder above a worktree outside the home folder', async () => {
    const { calls, exec } = fake();
    const run = sandboxedChecks(
      options(exec, { platform: 'darwin', gitDirOf: () => undefined, temp: folders().temp }),
    );
    await run(line, [], { ...call, cwd: '/srv/work/1' });
    assert.deepEqual(calls[0]?.args.slice(8), ['-p', seatbeltProfile(0), '/bin/sh', '-c', line]);
  });

  it('names no folder above a worktree in a folder whose name only starts with the home folder', async () => {
    const { calls, exec } = fake();
    const run = sandboxedChecks(
      options(exec, { platform: 'darwin', gitDirOf: () => undefined, temp: folders().temp }),
    );
    await run(line, [], { ...call, cwd: '/home/adam/w/1' });
    assert.deepEqual(calls[0]?.args.slice(8), ['-p', seatbeltProfile(0), '/bin/sh', '-c', line]);
  });

  it('names / and each folder down to the worktree when the home folder is /', async () => {
    const { calls, exec } = fake();
    const run = sandboxedChecks(
      options(exec, {
        platform: 'darwin',
        home: '/',
        gitDirOf: () => undefined,
        temp: folders().temp,
      }),
    );
    await run(line, [], { ...call, cwd: '/w/1' });
    assert.deepEqual(calls[0]?.args.slice(8, 12), ['-D', 'PARENT_0=/', '-D', 'PARENT_1=/w']);
    assert.equal(calls[0]?.args[13], seatbeltProfile(2));
  });

  it('lets a check stat the folders above its worktree in the home folder, and read nothing else there', () => {
    assert.equal(
      seatbeltProfile(2),
      seatbeltProfile(0).replace(
        '(allow file-read* (subpath',
        '(allow file-read-metadata (literal (param "PARENT_0")) (literal (param "PARENT_1")))\n(allow file-read* (subpath',
      ),
    );
  });

  it('denies the network, the Keychain, writes outside the worktree and the temp folder, and reads of the home', () => {
    assert.equal(
      seatbeltProfile(0),
      [
        '(version 1)',
        '(allow default)',
        '(deny network*)',
        '(deny mach-lookup (global-name "com.apple.SecurityServer"))',
        // launchd and LaunchServices start what they are asked to outside the sandbox.
        '(deny job-creation)',
        '(deny lsopen)',
        '(deny appleevent-send)',
        '(deny mach-lookup (global-name "com.apple.coreservices.launchservicesd"))',
        '(deny file-write*)',
        '(allow file-write* (subpath (param "WORKTREE")) (subpath (param "TEMP")) (literal "/dev/null") (literal "/dev/stdout") (literal "/dev/stderr") (literal "/dev/tty") (regex #"^/dev/fd/"))',
        '(deny file-read* (subpath (param "HOME")))',
        '(allow file-read* (subpath (param "WORKTREE")) (subpath (param "GIT_DIR")))',
        '',
      ].join('\n'),
    );
  });

  it('gives the worktree as the repository when it names none', async () => {
    const { calls, exec } = fake();
    const run = sandboxedChecks(
      options(exec, { platform: 'darwin', gitDirOf: () => undefined, temp: folders().temp }),
    );
    await run(line, [], call);
    assert.equal(calls[0]?.args[5], `GIT_DIR=${worktree}`);
  });

  it('removes the temporary folder also when the run throws', async () => {
    const { removed, temp: made } = folders();
    const run = sandboxedChecks(
      options(() => Promise.reject(new Error('spawn failed')), { platform: 'darwin', temp: made }),
    );
    await assert.rejects(run(line, [], call), /spawn failed/);
    assert.deepEqual(removed, [temp]);
  });

  it('reads a sandbox-exec that could not apply its profile as a check that could not start', async () => {
    const stderr = 'sandbox-exec: sandbox_apply: Operation not permitted\n';
    const { exec } = fake({ exitCode: 71, stderr, output: stderr });
    const run = sandboxedChecks(options(exec, { platform: 'darwin', temp: folders().temp }));
    const result = await run(line, [], call);
    assert.equal(result.exitCode, null);
    assert.match(result.output, /sandbox-exec: sandbox_apply: Operation not permitted/);
  });

  it('gives the temporary folder by its real path: Seatbelt matches real paths, and macOS keeps it under the /var link', async () => {
    const { calls, exec } = fake();
    const { removed, temp: made } = folders();
    const realPath = (path: string) => (path === temp ? `/real${temp}` : path);
    const run = sandboxedChecks(options(exec, { platform: 'darwin', temp: made, realPath }));
    await run(line, [], call);
    assert.equal(calls[0]?.args[7], `TEMP=/real${temp}`);
    assert.equal(calls[0]?.options.env?.TMPDIR, `/real${temp}`);
    assert.equal(calls[0]?.options.env?.HOME, `/real${temp}`);
    assert.deepEqual(removed, [temp]);
  });

  it('removes the temporary folder when its real path cannot be read, running nothing', async () => {
    const { calls, exec } = fake();
    const { removed, temp: made } = folders();
    const realPath = (path: string) => {
      if (path === temp) throw new Error('ELOOP: too many links');
      return path;
    };
    const run = sandboxedChecks(options(exec, { platform: 'darwin', temp: made, realPath }));
    const result = await run(line, [], call);
    assert.deepEqual(calls, []);
    assert.equal(result.exitCode, null);
    assert.match(result.output, /ELOOP/);
    assert.deepEqual(removed, [temp]);
  });

  it("keeps the check's result when its temporary folder cannot be removed, and says so", async () => {
    const { exec } = fake({ exitCode: 1, output: 'not ok 1\n' });
    const temp = {
      make: () => '/private/var/folders/x/T/foedrum-check-2',
      remove: (): Promise<void> => Promise.reject(new Error('EPERM: operation not permitted')),
    };
    const run = sandboxedChecks(options(exec, { platform: 'darwin', temp }));
    const result = await run(line, [], call);
    assert.equal(result.exitCode, 1);
    assert.match(result.output, /^not ok 1\n/);
    assert.match(result.output, /foedrum-check-2.*EPERM/);
  });

  it('does not run the line when its temporary folder cannot be made: it could not start, and says why', async () => {
    const { calls, exec } = fake();
    const { removed } = folders();
    const temp = {
      make: (): string => {
        throw new Error('ENOSPC: no space left on device');
      },
      remove: async (path: string) => {
        removed.push(path);
      },
    };
    const run = sandboxedChecks(options(exec, { platform: 'darwin', temp }));
    const result = await run(line, [], call);
    assert.deepEqual(calls, []);
    assert.deepEqual(removed, []);
    assert.equal(result.exitCode, null);
    assert.match(result.output, /ENOSPC/);
  });

  it('does not run the line without sandbox-exec: it could not start, and says why', async () => {
    const { calls, exec } = fake();
    const { removed, temp: made } = folders();
    const run = sandboxedChecks(
      options(exec, { platform: 'darwin', hasSandboxExec: () => false, temp: made }),
    );
    const result = await run(line, [], call);
    assert.deepEqual(calls, []);
    assert.deepEqual(removed, []);
    assert.equal(result.exitCode, null);
    assert.match(result.output, /\/usr\/bin\/sandbox-exec is not there.*\(ADR 0076\)/);
  });
});

/**
 * A fake runner for a setup's two processes on Linux (ADR 0218): bwrap writes its child's pid to
 * fd 3 (in the chunks `info` gives) and runs the line once fd 4 has a byte; the stack is up,
 * fails, exits without coming up, or hangs, as `stack` says. `bwrap` says how bwrap ends: when the
 * line is done, when it is stopped mid-line, at its deadline once the stack has started, or under
 * its own name before or after it would tell a pid. What it records: the calls, the order of
 * events and the resolver's file bwrap was given on fd 5.
 */
const fakeSetup = ({
  info = ['{\n    "child-pid": 4242\n}\n'],
  stack = 'up',
  bwrap = 'line-ends',
  answer = {},
}: {
  info?: readonly string[];
  stack?: 'up' | 'fails' | 'exits-before-up' | 'hangs';
  bwrap?: 'line-ends' | 'line-runs-until-stopped' | 'times-out' | 'fails-at-once' | 'fails-late';
  answer?: Partial<ExecResult>;
} = {}) => {
  const calls: { file: string; args: readonly string[]; options: ExecOptions }[] = [];
  const events: string[] = [];
  const resolver = { text: '' };
  const handed: Duplex[][] = [];
  const ran = (more: Partial<ExecResult> = {}): ExecResult => ({
    exitCode: 0,
    stdout: '',
    stderr: '',
    output: '',
    ...more,
  });
  const ownFailure = 'bwrap: setting up uid map: Permission denied\n';
  const stopped = (signal: AbortSignal | undefined, what: string, more: Partial<ExecResult> = {}) =>
    new Promise<ExecResult>((done) => {
      const stop = () => {
        events.push(what);
        done(ran({ exitCode: null, killed: 'stopped', ...more }));
      };
      if (signal?.aborted) stop();
      else signal?.addEventListener('abort', stop, { once: true });
    });
  // Resolves once `event` is among the events, checked after each turn of the event loop.
  const once = (event: string) =>
    new Promise<void>((done) => {
      const look = () => (events.includes(event) ? done() : setImmediate(look));
      look();
    });
  const exec: ExecProcess = async (file, args, options) => {
    calls.push({ file, args, options });
    const pipes = Array.from({ length: options.pipes?.count ?? 0 }, () => new PassThrough());
    handed.push(pipes);
    options.pipes?.onPipes(pipes);
    const [first, second, third] = pipes;
    if (file === '/usr/bin/bwrap') {
      if (first === undefined || second === undefined) return ran(answer);
      if (bwrap === 'fails-at-once') {
        first.end();
        return ran({ exitCode: 1, stderr: ownFailure, output: ownFailure });
      }
      if (bwrap === 'fails-late') {
        // Its info pipe closes first, and the runner sees it end only after Foedrum stopped it.
        first.end();
        return stopped(options.signal, 'bwrap stopped', { stderr: ownFailure, output: ownFailure });
      }
      for (const chunk of info.slice(0, -1)) first.write(chunk);
      first.end(info.at(-1));
      if (bwrap === 'times-out') {
        return once(`${stack === 'up' ? 'the line runs' : 'slirp4netns starts'}`).then(() => {
          events.push('bwrap timed out');
          return ran({ exitCode: null, killed: 'timed-out' });
        });
      }
      return Promise.race([
        new Promise<ExecResult>((done) =>
          second.once('data', () => {
            // bwrap has read the resolver's file by the time the line runs.
            resolver.text = String(third?.read() ?? '');
            events.push('the line runs');
            if (bwrap === 'line-ends') done(ran(answer));
          }),
        ),
        stopped(options.signal, 'bwrap stopped'),
      ]);
    }
    const tool = file === '/usr/bin/pasta' ? 'pasta' : 'slirp4netns';
    events.push(`${tool} starts`);
    if (stack === 'fails') {
      const said = `${tool}: Couldn't open user namespace /proc/4242/ns/user: Permission denied\n`;
      return ran({ exitCode: 1, stderr: said, output: said });
    }
    // A slirp4netns that ends cleanly before it said it was up: never a namespace with a network.
    if (stack === 'exits-before-up') return ran();
    if (stack === 'hangs') return stopped(options.signal, `${tool} stopped`);
    // pasta forks to the background once the namespace is up; slirp4netns says so on fd 3.
    if (tool === 'pasta') return ran();
    first?.write('1');
    return stopped(options.signal, 'slirp4netns stopped');
  };
  return { calls, events, resolver, handed, exec };
};

const stackTools =
  (...found: NetworkStackTool[]) =>
  (name: NetworkStackTool) =>
    found.includes(name) ? `/usr/bin/${name}` : undefined;

const PASTA_ARGS = [
  '--config-net',
  '--quiet',
  '-4',
  '-a',
  '10.0.2.100',
  '-n',
  '24',
  '-g',
  '10.0.2.2',
  '--no-map-gw',
  '-t',
  'none',
  '-u',
  'none',
  '-T',
  'none',
  '-U',
  'none',
  '--dns-forward',
  '10.0.2.3',
  '4242',
];

const SLIRP4NETNS_ARGS = [
  '--configure',
  '--mtu=65520',
  '--disable-host-loopback',
  '--ready-fd=3',
  '--exit-fd=4',
  '4242',
  'tap0',
];

/**
 * A setup's /dev, built without devpts: with `--dev /dev`, bwrap maps the user to root in one user
 * namespace to mount devpts and makes a second inside it, and the network namespace belongs to
 * the outer one, which no stack can join (ADR 0218, CI run of #425).
 */
const SETUP_DEV = [
  ...['--tmpfs', '/dev'],
  ...['--dev-bind', '/dev/null', '/dev/null'],
  ...['--dev-bind', '/dev/zero', '/dev/zero'],
  ...['--dev-bind', '/dev/full', '/dev/full'],
  ...['--dev-bind', '/dev/random', '/dev/random'],
  ...['--dev-bind', '/dev/urandom', '/dev/urandom'],
  ...['--dev-bind', '/dev/tty', '/dev/tty'],
  ...['--tmpfs', '/dev/shm'],
  ...['--symlink', '/proc/self/fd', '/dev/fd'],
  ...['--symlink', '/proc/self/fd/0', '/dev/stdin'],
  ...['--symlink', '/proc/self/fd/1', '/dev/stdout'],
  ...['--symlink', '/proc/self/fd/2', '/dev/stderr'],
];

const linuxSetup = (exec: ExecProcess, more: Partial<SandboxedChecksOptions> = {}) =>
  sandboxedChecks(
    options(exec, {
      platform: 'linux',
      network: true,
      findStackTool: stackTools('pasta', 'slirp4netns'),
      ...more,
    }),
  );

// A repository's setup installs, so its sandbox keeps the network and nothing else (ADR 0158),
// through a network namespace of its own on Linux and WSL2 (ADR 0218).
describe('sandboxedChecks with the network kept, for a setup', () => {
  it("starts the line in bwrap with a network namespace of its own, which pasta joins before the line runs where slirp4netns is not on PATH, everything else as a check's", async () => {
    const checked = fake();
    await sandboxedChecks(options(checked.exec, { platform: 'linux' }))(line, [], call);
    const checkArgs = checked.calls[0]?.args ?? [];
    const { calls, events, resolver, exec } = fakeSetup({ answer: { exitCode: 3 } });
    const result = await linuxSetup(exec, { findStackTool: stackTools('pasta') })(line, [], call);
    assert.equal(result.exitCode, 3);
    const at = checkArgs.indexOf('--unshare-net') + 1;
    const dev = checkArgs.indexOf('--dev');
    const after = checkArgs.indexOf(home) + 1;
    assert.deepEqual(calls[0]?.args, [
      ...checkArgs.slice(0, at),
      ...['--info-fd', '3', '--block-fd', '4'],
      ...checkArgs.slice(at, dev),
      ...SETUP_DEV,
      ...checkArgs.slice(dev + 2, after),
      ...['--ro-bind-data', '5', '/etc/resolv.conf'],
      ...checkArgs.slice(after),
    ]);
    assert.equal(calls[0]?.file, '/usr/bin/bwrap');
    assert.equal(calls[0]?.options.pipes?.count, 3);
    assert.equal(calls[0]?.options.shell, false);
    assert.equal(calls[0]?.options.timeoutMs, call.timeoutMs);
    // pasta attaches to bwrap's child, with the host's loopback and every forwarded port closed.
    assert.deepEqual(
      calls.slice(1).map(({ file, args }) => ({ file, args })),
      [{ file: '/usr/bin/pasta', args: PASTA_ARGS }],
    );
    assert.equal(calls[1]?.options.cwd, worktree);
    assert.equal(calls[1]?.options.timeoutMs, call.timeoutMs);
    assert.equal(calls[1]?.options.shell, undefined);
    assert.deepEqual(events, ['pasta starts', 'the line runs']);
    // The stack's resolver, never the host's 127.0.0.53, which the namespace's own loopback is.
    assert.equal(resolver.text, 'nameserver 10.0.2.3\n');
  });

  it('uses slirp4netns, and stops it once bwrap has ended', async () => {
    const { calls, events, resolver, exec } = fakeSetup();
    const result = await linuxSetup(exec, { findStackTool: stackTools('slirp4netns') })(
      line,
      [],
      call,
    );
    assert.equal(result.exitCode, 0);
    assert.deepEqual(calls[1]?.file, '/usr/bin/slirp4netns');
    assert.deepEqual(calls[1]?.args, SLIRP4NETNS_ARGS);
    // Its --ready-fd and --exit-fd.
    assert.equal(calls[1]?.options.pipes?.count, 2);
    assert.deepEqual(events, ['slirp4netns starts', 'the line runs', 'slirp4netns stopped']);
    assert.equal(resolver.text, 'nameserver 10.0.2.3\n');
  });

  // Ubuntu confines pasta under passt's AppArmor profile, and lets slirp4netns into user
  // namespaces (ADR 0218).
  it('prefers slirp4netns when both are there', async () => {
    const { calls, exec } = fakeSetup();
    await linuxSetup(exec)(line, [], call);
    assert.equal(calls[1]?.file, '/usr/bin/slirp4netns');
  });

  it('does not start without slirp4netns or pasta, and says so', async () => {
    const { calls, exec } = fakeSetup();
    const result = await linuxSetup(exec, { findStackTool: stackTools() })(line, [], call);
    assert.deepEqual(calls, []);
    assert.equal(result.exitCode, null);
    assert.match(
      result.output,
      /^neither slirp4netns nor pasta \(passt\) is on PATH: a repository's setup runs only in a network namespace of its own here; install slirp4netns \(ADR 0218\)\n$/,
    );
  });

  it("reads as not started, with the stack's message, when the stack fails, and the line never runs", async () => {
    for (const tool of ['pasta', 'slirp4netns'] as const) {
      const { events, exec } = fakeSetup({ stack: 'fails' });
      const result = await linuxSetup(exec, { findStackTool: stackTools(tool) })(line, [], call);
      assert.equal(result.exitCode, null, tool);
      assert.equal(result.killed, undefined, tool);
      assert.match(
        result.output,
        new RegExp(`^${tool}: Couldn't open user namespace /proc/4242/ns/user: Permission denied`),
      );
      assert.deepEqual(events, [`${tool} starts`, 'bwrap stopped'], tool);
    }
  });

  it('reads as not started, and starts no stack, when bwrap fails before it tells its pid', async () => {
    const { calls, exec } = fakeSetup({ bwrap: 'fails-at-once' });
    const result = await linuxSetup(exec)(line, [], call);
    assert.equal(calls.length, 1);
    assert.equal(result.exitCode, null);
    assert.match(result.output, /^bwrap: setting up uid map: Permission denied \(ADR 0076\)/);
  });

  it('stops bwrap, and reads as not started, when its pid cannot be read', async () => {
    const { calls, events, exec } = fakeSetup({ info: ['{"child-pid": "x"}'] });
    const result = await linuxSetup(exec)(line, [], call);
    assert.equal(calls.length, 1);
    assert.deepEqual(events, ['bwrap stopped']);
    assert.equal(result.exitCode, null);
    assert.match(result.output, /^bwrap gave no child pid on its --info-fd/);
  });

  // Review of #564: its info pipe can close before the runner sees it end, and Foedrum then stops
  // it for want of a pid; what it said under its own name is still the reason.
  it('reads as not started with what bwrap said, when it fails after its info pipe closed', async () => {
    const { calls, exec } = fakeSetup({ bwrap: 'fails-late' });
    const result = await linuxSetup(exec)(line, [], call);
    assert.equal(calls.length, 1);
    assert.equal(result.exitCode, null);
    assert.equal(result.killed, undefined);
    assert.match(result.output, /^bwrap: setting up uid map: Permission denied \(ADR 0076\)/);
  });

  // Review of #564: the stack Foedrum stops once bwrap has ended has not failed.
  it('reads as timed out when the deadline passes before the stack is up, and stops the stack', async () => {
    const { events, exec } = fakeSetup({ stack: 'hangs', bwrap: 'times-out' });
    const result = await linuxSetup(exec, { findStackTool: stackTools('slirp4netns') })(
      line,
      [],
      call,
    );
    assert.equal(result.killed, 'timed-out');
    assert.equal(result.exitCode, null);
    assert.doesNotMatch(result.output, /slirp4netns/);
    assert.deepEqual(events, ['slirp4netns starts', 'bwrap timed out', 'slirp4netns stopped']);
  });

  it('reads no pid of 0, nor from JSON that ends before it is whole', async () => {
    for (const info of [['{"child-pid": 0}'], ['{"child-']]) {
      const { calls, events, exec } = fakeSetup({ info });
      const result = await linuxSetup(exec)(line, [], call);
      assert.equal(calls.length, 1, info[0]);
      assert.deepEqual(events, ['bwrap stopped'], info[0]);
      assert.match(result.output, /^bwrap gave no child pid on its --info-fd/, info[0]);
    }
  });

  it('reads the pid bwrap writes in more than one piece', async () => {
    const { calls, events, exec } = fakeSetup({ info: ['{\n    "child-', 'pid": 42', '42\n}\n'] });
    const result = await linuxSetup(exec)(line, [], call);
    assert.equal(result.exitCode, 0);
    assert.deepEqual(calls[1]?.args, SLIRP4NETNS_ARGS);
    assert.deepEqual(events, ['slirp4netns starts', 'the line runs', 'slirp4netns stopped']);
  });

  // ADR 0218: a stack that exits before it is up fails, whatever its exit code.
  it('reads as not started, and never runs the line, when slirp4netns ends cleanly before it is up', async () => {
    const { events, exec } = fakeSetup({ stack: 'exits-before-up' });
    const result = await linuxSetup(exec, { findStackTool: stackTools('slirp4netns') })(
      line,
      [],
      call,
    );
    assert.equal(result.exitCode, null);
    assert.match(result.output, /^slirp4netns: exit code 0 \(ADR 0218\)/);
    assert.deepEqual(events, ['slirp4netns starts', 'bwrap stopped']);
  });

  // Ubuntu's /etc/resolv.conf links into /run, which the sandbox hides: the stack's file goes
  // where the link points, so the link finds it.
  it("gives the resolver's file at the real path of /etc/resolv.conf, and a check none", async () => {
    const stub = '/run/systemd/resolve/stub-resolv.conf';
    const realPath = (path: string) => (path === '/etc/resolv.conf' ? stub : path);
    const { calls, exec } = fakeSetup();
    await linuxSetup(exec, { realPath })(line, [], call);
    const args = calls[0]?.args ?? [];
    const at = args.indexOf('/run');
    assert.deepEqual(args.slice(at - 1, at + 6), [
      '--tmpfs',
      '/run',
      '--tmpfs',
      home,
      '--ro-bind-data',
      '5',
      stub,
    ]);
    const unresolved = fakeSetup();
    await linuxSetup(unresolved.exec, {
      realPath: (path: string) => {
        if (path === '/etc/resolv.conf') throw new Error('ELOOP: too many links');
        return path;
      },
    })(line, [], call);
    const given = unresolved.calls[0]?.args ?? [];
    assert.equal(given[given.indexOf('--ro-bind-data') + 2], '/etc/resolv.conf');
    // A check has no network, so it gets no resolver, no pipes and no stack.
    const checked = fake();
    const check = sandboxedChecks(
      options(checked.exec, { platform: 'linux', realPath, findStackTool: stackTools('pasta') }),
    );
    await check(line, [], call);
    assert.equal(checked.calls.length, 1);
    assert.ok(!checked.calls[0]?.args.includes('--ro-bind-data'));
    assert.ok(!checked.calls[0]?.args.includes('--info-fd'));
    assert.equal(checked.calls[0]?.options.pipes, undefined);
  });

  it('ends the run as stopped, the stack after it, when the caller stops it while the line runs', async () => {
    const stop = new AbortController();
    const { events, exec } = fakeSetup({ bwrap: 'line-runs-until-stopped' });
    const running = linuxSetup(exec, { findStackTool: stackTools('slirp4netns') })(line, [], {
      ...call,
      signal: stop.signal,
    });
    await new Promise<void>((done) => {
      const look = () => (events.includes('the line runs') ? done() : setImmediate(look));
      look();
    });
    stop.abort();
    const result = await running;
    assert.equal(result.killed, 'stopped');
    assert.deepEqual(events, [
      'slirp4netns starts',
      'the line runs',
      'bwrap stopped',
      'slirp4netns stopped',
    ]);
  });

  // Seatbelt's network* also covers Unix sockets, such as launchd's ssh-agent under /private/tmp
  // (review of #422): only IP is let through, and the resolver's socket for name lookups.
  it('starts the line under the profile with IP kept and Unix sockets denied but the resolver, everything else as a check', async () => {
    assert.equal(
      seatbeltProfile(2, { network: true }),
      seatbeltProfile(2).replace(
        '(deny network*)\n',
        '(deny network-outbound (remote unix-socket))\n(allow network-outbound (remote unix-socket (path-literal "/private/var/run/mDNSResponder")))\n',
      ),
    );
    const { calls, exec } = fake();
    const temp = { make: () => '/private/var/folders/x/T/foedrum-check-3', remove: async () => {} };
    const run = sandboxedChecks(options(exec, { platform: 'darwin', network: true, temp }));
    await run(line, [], call);
    const args = calls[0]?.args ?? [];
    assert.equal(args[args.indexOf('-p') + 1], seatbeltProfile(8, { network: true }));
    assert.equal(calls[0]?.options.env?.HOME, '/private/var/folders/x/T/foedrum-check-3');
  });

  it('does not run the line without bwrap or sandbox-exec, as a check', async () => {
    const { calls, exec } = fake();
    const linux = { platform: 'linux', network: true, findBwrap: () => undefined } as const;
    assert.equal((await sandboxedChecks(options(exec, linux))(line, [], call)).exitCode, null);
    const mac = { platform: 'darwin', network: true, hasSandboxExec: () => false } as const;
    assert.equal((await sandboxedChecks(options(exec, mac))(line, [], call)).exitCode, null);
    assert.deepEqual(calls, []);
  });

  it('runs the line as before on native Windows', async () => {
    const { calls, exec } = fake();
    await sandboxedChecks(options(exec, { platform: 'win32', network: true }))(line, [], call);
    assert.deepEqual(calls, [{ file: line, args: [], options: call }]);
  });
});

describe('sandboxedChecks elsewhere', () => {
  it('runs the line as before on native Windows, which has no sandbox for shell commands', async () => {
    const { calls, exec } = fake();
    const run = sandboxedChecks(options(exec, { platform: 'win32' }));
    await run(line, [], call);
    assert.deepEqual(calls, [{ file: line, args: [], options: call }]);
  });

  it('passes a call that is no command line on as it is', async () => {
    const { calls, exec } = fake();
    const run = sandboxedChecks(options(exec, { platform: 'linux' }));
    await run('git', ['status'], { cwd: worktree });
    assert.deepEqual(calls, [{ file: 'git', args: ['status'], options: { cwd: worktree } }]);
  });
});

describe('worktreeGitDir', () => {
  /** A worktree folder whose `.git` holds `text`, or is a folder when `text` is undefined. */
  const worktreeWith = (text: string | undefined) => {
    const dir = makeTempDir('git-dir');
    const path = join(dir.path, 'worktree');
    mkdirSync(path);
    if (text === undefined) mkdirSync(join(path, '.git'));
    else writeFileSync(join(path, '.git'), text);
    return { dir, path };
  };

  /** A repository with the record of a linked worktree whose `gitdir` file holds `back`. */
  const recordIn = (dir: string, back: string) => {
    const repository = join(dir, 'clone', '.git');
    const record = join(repository, 'worktrees', 'green-1');
    mkdirSync(record, { recursive: true });
    writeFileSync(join(record, 'gitdir'), `${back}\n`);
    return { repository, record };
  };

  it("names the repository a linked worktree's record sits in, when the record names the worktree back", () => {
    const { dir } = worktreeWith(undefined);
    try {
      const { repository, record } = recordIn(dir.path, join(dir.path, 'linked', '.git'));
      const linked = join(dir.path, 'linked');
      mkdirSync(linked);
      writeFileSync(join(linked, '.git'), `gitdir: ${record}\n`);
      assert.equal(worktreeGitDir(linked), repository);
    } finally {
      dir.remove();
    }
  });

  // A check writes its worktree, `.git` included: a later check of the step must not get the
  // home folder or /run bound back in by naming it there (review of #357).
  it('names none when the record does not name the worktree back, as a rewritten .git would', () => {
    const { dir, path } = worktreeWith(undefined);
    try {
      const { record } = recordIn(dir.path, join(dir.path, 'other', '.git'));
      const forged = join(dir.path, 'forged');
      mkdirSync(forged);
      writeFileSync(join(forged, '.git'), `gitdir: ${record}\n`);
      assert.equal(worktreeGitDir(forged), undefined);
      // A folder that is no worktree record, such as the home folder.
      writeFileSync(join(forged, '.git'), `gitdir: ${join(dir.path, 'home')}\n`);
      assert.equal(worktreeGitDir(forged), undefined);
      assert.equal(worktreeGitDir(path), undefined);
    } finally {
      dir.remove();
    }
  });

  // git writes the record with the real path; serve may name the worktree through a link, as
  // where /home links to /var/home (review of #357).
  it('names the repository when the worktree is reached through a link to where git recorded it', () => {
    const { dir } = worktreeWith(undefined);
    try {
      const real = join(dir.path, 'real');
      const linked = join(real, 'linked');
      mkdirSync(linked, { recursive: true });
      const { repository, record } = recordIn(dir.path, join(linked, '.git'));
      writeFileSync(join(linked, '.git'), `gitdir: ${record}\n`);
      const link = join(dir.path, 'link');
      symlinkSync(real, link, 'junction');
      assert.equal(worktreeGitDir(join(link, 'linked')), repository);
    } finally {
      dir.remove();
    }
  });

  it('names none for a repository inside the worktree, which is bound with it', () => {
    const { dir, path } = worktreeWith(undefined);
    try {
      assert.equal(worktreeGitDir(path), undefined);
    } finally {
      dir.remove();
    }
  });

  it('resolves a relative record against the worktree, and names none outside worktrees/', () => {
    const { dir, path } = worktreeWith('gitdir: ../clone/.git/worktrees/green-1\r\n');
    try {
      const { repository } = recordIn(dir.path, join(path, '.git'));
      assert.equal(worktreeGitDir(path), repository);
      writeFileSync(join(path, '.git'), 'gitdir: ../repo.git\n');
      assert.equal(worktreeGitDir(path), undefined);
    } finally {
      dir.remove();
    }
  });

  it('names none without a .git file, or one that names no gitdir', () => {
    const { dir, path } = worktreeWith('not a gitdir line');
    try {
      assert.equal(worktreeGitDir(path), undefined);
      assert.equal(worktreeGitDir(join(dir.path, 'missing')), undefined);
    } finally {
      dir.remove();
    }
  });
});

// A worktree of Foedrum's own git directory borrows the clone's objects through its alternates;
// the sandbox binds them only from a folder Foedrum alone writes (ADR 0203).
describe('sandboxedChecks for a repository that borrows an object store', () => {
  const store = '/home/ada/.foedrum/acme/clones/acme.api/.git/objects';
  const borrowing = {
    borrowedOf: (repository: string) => (repository === gitDir ? [store] : []),
    borrowsFrom: (repository: string) => repository === gitDir,
  };

  it('binds the store read-only in bwrap, after the repository and before the worktree', async () => {
    const { calls, exec } = fake();
    const run = sandboxedChecks(options(exec, { platform: 'linux', ...borrowing }));
    await run(line, [], call);
    assert.deepEqual(calls[0]?.args.slice(17, 26), [
      '--ro-bind',
      gitDir,
      gitDir,
      '--ro-bind',
      store,
      store,
      '--bind',
      worktree,
      worktree,
    ]);
    // Never writable.
    assert.equal(calls[0]?.args.filter((arg) => arg === store).length, 2);
    assert.equal(calls[0]?.args[calls[0].args.indexOf(store) - 1], '--ro-bind');
  });

  it('binds no store when the repository names none, or the worktree names no repository', async () => {
    const named = fake();
    await sandboxedChecks(options(named.exec, { platform: 'linux', borrowedOf: () => [] }))(
      line,
      [],
      call,
    );
    assert.ok(!named.calls[0]?.args.includes(store));
    const none = fake();
    await sandboxedChecks(
      options(none.exec, { platform: 'linux', gitDirOf: () => undefined, ...borrowing }),
    )(line, [], call);
    assert.ok(!none.calls[0]?.args.includes(store));
  });

  // A check writes its worktree, `.git` and a record inside it included: an alternates file there
  // must not bind the home folder or /run for a later check (review of #528).
  it('binds no store a repository inside the worktree names, and binds one beside it whose name only starts with it', async () => {
    const planted = `${worktree}/fake`;
    const inside = fake();
    await sandboxedChecks(
      options(inside.exec, {
        platform: 'linux',
        gitDirOf: () => planted,
        borrowedOf: () => [home, '/run'],
      }),
    )(line, [], call);
    const args = inside.calls[0]?.args ?? [];
    assert.ok(
      !args.some((arg, n) => arg === '--ro-bind' && [home, '/run'].includes(args[n + 1] ?? '')),
    );
    const beside = `${worktree}-own.git`;
    const outside = fake();
    await sandboxedChecks(
      options(outside.exec, {
        platform: 'linux',
        gitDirOf: () => beside,
        borrowedOf: (repository) => (repository === beside ? [store] : []),
        borrowsFrom: (repository) => repository === beside,
      }),
    )(line, [], call);
    assert.ok(outside.calls[0]?.args.includes(store));
  });

  it('binds no store under Seatbelt that a repository inside the worktree names', async () => {
    const { calls, exec } = fake();
    const temp = { make: () => '/private/var/folders/x/T/foedrum-check-1', remove: async () => {} };
    await sandboxedChecks(
      options(exec, {
        platform: 'darwin',
        temp,
        gitDirOf: () => worktree,
        borrowedOf: () => [home],
      }),
    )(line, [], call);
    assert.ok(!calls[0]?.args.some((arg) => arg.startsWith('BORROWED_')));
  });

  it('binds no store by default, from any repository', async () => {
    const { calls, exec } = fake();
    await sandboxedChecks(options(exec, { platform: 'linux', borrowedOf: () => [store] }))(
      line,
      [],
      call,
    );
    assert.ok(!calls[0]?.args.includes(store));
  });

  // A brewer or a check writes its own worktree, and a sibling attempt's path is plain to work out:
  // a record planted there is outside this worktree, but not in a folder Foedrum alone writes
  // (review of #528).
  it("binds no store a sibling attempt's worktree names, and binds one Foedrum's own git directory names", async () => {
    const gitDirs = '/home/ada/.foedrum/acme/acme.api/git-dirs';
    const borrowsFrom = insideFolders([gitDirs], (path) => path);
    const sibling = fake();
    await sandboxedChecks(
      options(sibling.exec, {
        platform: 'linux',
        gitDirOf: () => '/home/ada/.foedrum/acme/attempts/12-1/build/1/x',
        borrowedOf: () => [home],
        borrowsFrom,
      }),
    )(line, [], call);
    // The home folder only as the tmpfs that hides it.
    assert.equal(sibling.calls[0]?.args.filter((arg) => arg === home).length, 1);
    const own = fake();
    const ownDir = `${gitDirs}/0b6f2c1e-3d4a-4f5b-8c6d-7e8f9a0b1c2d.git`;
    await sandboxedChecks(
      options(own.exec, {
        platform: 'linux',
        gitDirOf: () => ownDir,
        borrowedOf: () => [store],
        borrowsFrom,
      }),
    )(line, [], call);
    assert.ok(own.calls[0]?.args.includes(store));
  });

  it('lets a check read the store under Seatbelt, as a parameter, and write nothing there', async () => {
    const { calls, exec } = fake();
    const temp = { make: () => '/private/var/folders/x/T/foedrum-check-1', remove: async () => {} };
    await sandboxedChecks(options(exec, { platform: 'darwin', temp, ...borrowing }))(
      line,
      [],
      call,
    );
    const args = calls[0]?.args ?? [];
    assert.ok(args.includes(`BORROWED_0=${store}`));
    const profile = args[args.indexOf('-p') + 1] ?? '';
    assert.match(profile, /\(allow file-read\* \(subpath \(param "BORROWED_0"\)\)\)/);
    // The one write rule names the worktree and the temporary folder only.
    const writes = profile.split('\n').filter((rule) => rule.startsWith('(allow file-write*'));
    assert.equal(writes.length, 1);
    assert.doesNotMatch(writes[0] ?? '', /BORROWED/);
  });

  it('names no store in the profile when the repository borrows none', () => {
    assert.doesNotMatch(seatbeltProfile(0), /BORROWED/);
    assert.match(seatbeltProfile(0, { borrowed: 2 }), /\(param "BORROWED_1"\)/);
  });
});

describe('insideFolders', () => {
  const root = '/home/ada/.foedrum/acme/acme.api/git-dirs';
  const own = `${root}/0b6f2c1e-3d4a-4f5b-8c6d-7e8f9a0b1c2d.git`;

  it('holds a repository whose real path lies inside a root, the root read by its real path too', () => {
    assert.equal(insideFolders([root], (path) => path)(own), true);
    const linked = (path: string) => path.replace('/home/ada/', '/var/home/ada/');
    assert.equal(insideFolders([root], linked)(linked(own)), true);
  });

  // A merged tree's worktree is `<uuid>.tree` in the root, which its check writes: only a direct
  // `<uuid>.git` child, which no check writes, holds (review of #528).
  it('holds no repository nested in the root, as one planted in a merged tree’s worktree is, nor a direct child that is no .git', () => {
    const inside = insideFolders([root], (path) => path);
    const tree = `${root}/0b6f2c1e-3d4a-4f5b-8c6d-7e8f9a0b1c2d.tree`;
    assert.equal(inside(`${tree}/evil`), false);
    assert.equal(inside(`${own}/worktrees`), false);
    assert.equal(inside(tree), false);
  });

  it('holds neither the root itself, nor a folder beside it whose name only starts with it, nor any other', () => {
    const inside = insideFolders([root], (path) => path);
    assert.equal(inside(root), false);
    assert.equal(inside(`${root}-x/0b6f2c1e.git`), false);
    assert.equal(inside('/home/ada/.foedrum/acme/attempts/12-1/build/1/x'), false);
  });

  // The sandbox gives it the repository's real path: a path under the root that is a link into a
  // worktree is the worktree's (review of #528).
  it('holds no repository named under the root through a link to a worktree', async () => {
    const worktreeFake = `${worktree}/fake`;
    const real = (path: string) => (path === `${root}/link.git` ? worktreeFake : path);
    const { calls, exec } = fake();
    await sandboxedChecks(
      options(exec, {
        platform: 'linux',
        realPath: real,
        gitDirOf: () => `${root}/link.git`,
        borrowedOf: () => [home],
        borrowsFrom: insideFolders([root], real),
      }),
    )(line, [], call);
    const args = calls[0]?.args ?? [];
    assert.equal(args.filter((arg) => arg === home).length, 1);
  });
});

describe('borrowedStores', () => {
  it("names each store a repository's alternates file lists, a relative one against its objects", () => {
    const dir = makeTempDir('borrowed');
    try {
      const repository = join(dir.path, 'own.git');
      mkdirSync(join(repository, 'objects', 'info'), { recursive: true });
      const absolute = join(dir.path, 'clone', '.git', 'objects');
      writeFileSync(
        join(repository, 'objects', 'info', 'alternates'),
        `${absolute}\n# a comment\n\n../../other/objects\n`,
      );
      assert.deepEqual(
        borrowedStores(repository),
        [absolute, join(repository, 'objects', '..', '..', 'other', 'objects')].map((path) =>
          resolve(path),
        ),
      );
    } finally {
      dir.remove();
    }
  });

  it('names none without an alternates file', () => {
    const dir = makeTempDir('borrowed');
    try {
      assert.deepEqual(borrowedStores(dir.path), []);
    } finally {
      dir.remove();
    }
  });
});
