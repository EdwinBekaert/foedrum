// The check sandbox against the real bwrap and sandbox-exec (ADR 0076): a check's command line
// cannot write outside its worktree, read a file in the home folder or open a connection to a
// server on 127.0.0.1. It tests our arguments and profile with the real tools, not the tools
// themselves; it runs where the sandbox runs (macOS, Linux with a working bwrap) and skips elsewhere.
// A setup's sandbox keeps the network and nothing else (ADR 0158): on Linux through a network
// namespace of its own that pasta or slirp4netns joins, which must be there on CI (ADR 0218); and
// what each stack can see of the host's files (ADR 0400).

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type Server } from 'node:net';
import { networkInterfaces } from 'node:os';
import { basename, join, relative } from 'node:path';
import { after, before, describe, it } from 'node:test';
import {
  bwrapArgs,
  type NetworkStackTool,
  SANDBOX_EXEC,
  sandboxedChecks,
} from '../../src/platform/check-sandbox.ts';
import { resolveExecutable } from '../../src/platform/executables.ts';
import { type ExecOptions, execProcess } from '../../src/platform/processes.ts';
import { waitUntil } from '../helpers/load.ts';
import { linuxResolverUnavailable } from '../helpers/resolver.ts';
import { makeTempDir, type TempDir } from '../helpers/temp-dir.ts';

/** Why the sandbox cannot run on this machine, or undefined when it can. */
const unavailable = (): string | undefined => {
  switch (process.platform) {
    case 'darwin':
      return existsSync(SANDBOX_EXEC) ? undefined : `${SANDBOX_EXEC} is not there`;
    case 'linux': {
      const bwrap = resolveExecutable('bwrap');
      if (bwrap === undefined) return 'bwrap is not on PATH';
      // Unprivileged namespaces may be off (a container, WSL 1, an AppArmor rule): probed with the
      // arguments a check gets, so the probe and the run agree.
      const probeDir = makeTempDir('check-sandbox-probe');
      try {
        const paths = { home: probeDir.path, worktree: probeDir.path, gitDir: undefined };
        const probe = spawnSync(bwrap, bwrapArgs(paths, 'true'), { timeout: 30_000 });
        if (probe.status === 0) return undefined;
        // bwrap's own line, such as Ubuntu's AppArmor refusing its user namespace.
        const said =
          String(probe.stderr ?? '')
            .trim()
            .split('\n')[0] ?? '';
        return `bwrap cannot make its sandbox here: ${said}`;
      } finally {
        probeDir.remove();
      }
    }
    default:
      return `no check sandbox on ${process.platform} (ADR 0076)`;
  }
};

const skip = unavailable();

const inCi = process.env.CI !== undefined && process.env.CI !== '';

/**
 * Why a setup cannot run here besides the sandbox: on Linux it needs a user-mode network stack
 * (ADR 0218). On CI's Linux leg that is a failure, not a skip, so the leg proves the isolation.
 */
const setupUnavailable = (): string | undefined => {
  if (skip !== undefined) return skip;
  if (process.platform !== 'linux' || inCi) return undefined;
  const found = ['slirp4netns', 'pasta'].some((tool) => resolveExecutable(tool) !== undefined);
  return found ? undefined : 'neither slirp4netns nor pasta (passt) is on PATH';
};

/** /etc/resolv.conf's text, or undefined when it cannot be read. */
const resolvConf = (): string | undefined => {
  try {
    return readFileSync('/etc/resolv.conf', 'utf8');
  } catch {
    return undefined;
  }
};

const resolverSkip = (): string | undefined =>
  linuxResolverUnavailable({
    platform: process.platform,
    inCi,
    slirp4netns: process.platform === 'linux' && resolveExecutable('slirp4netns') !== undefined,
    resolvConf: process.platform === 'linux' ? resolvConf() : undefined,
  });

/** A server that counts its connections, listening where it is told. */
const counting = async (listen: (server: Server, done: () => void) => void) => {
  let connections = 0;
  const server = createServer((socket) => {
    connections++;
    socket.destroy();
  });
  await new Promise<void>((done, fail) => {
    server.once('error', fail);
    listen(server, done);
  });
  const address = server.address();
  return {
    port: typeof address === 'object' && address !== null ? address.port : 0,
    connections: () => connections,
    close: () => new Promise((done) => server.close(done)),
  };
};

/**
 * node connecting to `target` (its connect arguments): exit 0 when it connected, 3 when not. With
 * `unansweredAfterMs`, also 3 when nothing answers by then, as an unmapped gateway may not: a hang
 * guard for a refusal only, never a limit on a connection that should be made (ADR 0070).
 */
const connectLine = (target: string, unansweredAfterMs?: number) => {
  const guard =
    unansweredAfterMs === undefined ? '' : `.setTimeout(${unansweredAfterMs},()=>process.exit(3))`;
  return `"${process.execPath}" -e "require('net').connect(${target}).on('connect',()=>process.exit(0)).on('error',()=>process.exit(3))${guard}"`;
};

/** An IPv4 address of this machine that is not the loopback, or undefined. */
const outsideAddress = (): string | undefined =>
  Object.values(networkInterfaces())
    .flat()
    .find((found) => found !== undefined && found.family === 'IPv4' && !found.internal)?.address;

describe('a check in the real sandbox', { skip: skip ?? false }, () => {
  let dir: TempDir;
  let home: string;
  let worktree: string;
  let outside: string;
  let run: ReturnType<typeof sandboxedChecks>;
  const check = (line: string, cwd = worktree) => {
    // Without the test runner's own variable, so a node --test inside runs its files.
    const { NODE_TEST_CONTEXT: _, ...env } = process.env;
    const call: ExecOptions = { cwd, env, shell: true, timeoutMs: 60_000 };
    return run(line, [], call);
  };

  before(() => {
    dir = makeTempDir('check-sandbox');
    home = join(dir.path, 'home');
    worktree = join(dir.path, 'worktree');
    outside = join(dir.path, 'outside');
    for (const folder of [home, worktree, outside]) mkdirSync(folder);
    writeFileSync(join(home, 'secret.txt'), 'planted-login\n');
    run = sandboxedChecks({ exec: execProcess, home });
  });
  after(() => dir.remove());

  it('writes in its worktree, and not outside it', async () => {
    const result = await check(`echo in > inside.txt && echo out > "${outside}/x.txt"`);
    assert.notEqual(result.exitCode, 0, result.output);
    assert.ok(existsSync(join(worktree, 'inside.txt')), result.output);
    assert.ok(!existsSync(join(outside, 'x.txt')), result.output);
  });

  it('cannot read a file in the home folder', async () => {
    writeFileSync(join(worktree, 'own.txt'), 'own-text\n');
    const result = await check(`cat own.txt && cat "${home}/secret.txt"`);
    // It ran, read its worktree, and was refused the home folder.
    assert.match(result.output, /own-text/);
    assert.notEqual(result.exitCode, 0, result.output);
    assert.doesNotMatch(result.output, /planted-login/);
  });

  // Foedrum's default work root is in the home folder, and node resolves a module's path by an
  // lstat of every folder above it, the home folder among them (#376).
  it('runs node --test in a worktree inside the home folder, which it still cannot read or list', async () => {
    const inside = join(home, 'work', 'attempt');
    mkdirSync(inside, { recursive: true });
    writeFileSync(
      join(inside, 'ok.test.mjs'),
      "import test from 'node:test';\ntest('runs', () => {});\n",
    );
    const result = await check(`"${process.execPath}" --test --test-reporter=tap`, inside);
    assert.equal(result.exitCode, 0, result.output);
    assert.match(result.output, /# pass 1/);
    const read = await check(`cat "${home}/secret.txt"`, inside);
    assert.notEqual(read.exitCode, 0, read.output);
    assert.doesNotMatch(read.output, /planted-login/);
    const list = await check(`ls -A "${home}"`, inside);
    assert.doesNotMatch(list.output, /secret\.txt/);
  });

  // gh's login in the OS keyring (ADR 0073): the user's D-Bus socket under /run on Linux. The
  // macOS Keychain is not asked, inside the sandbox or out: no test reaches the OS keyring
  // (CLAUDE.md); the unit test pins the profile's denial.
  it('sees an empty /run on Linux, where the D-Bus socket was', {
    skip: process.platform !== 'linux' && 'the keyring socket is a Linux path',
  }, async () => {
    const result = await check('ls -A /run');
    assert.equal(result.exitCode, 0, result.output);
    assert.equal(result.output.trim(), '');
  });

  it('cannot open a connection to a server on 127.0.0.1', async () => {
    let connections = 0;
    const server = createServer((socket) => {
      connections++;
      socket.destroy();
    });
    const reached = new Promise((done) => server.once('connection', done));
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    try {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      const connect = `require('net').connect(${port},'127.0.0.1').on('connect',()=>process.exit(0)).on('error',()=>process.exit(3))`;
      const line = `"${process.execPath}" -e "${connect}"`;
      // The same line outside the sandbox reaches the server: the refusal is the sandbox's.
      const open = await execProcess(line, [], { cwd: worktree, shell: true, timeoutMs: 60_000 });
      assert.equal(open.exitCode, 0, open.output);
      await reached;
      const before = connections;
      const result = await check(line);
      // node ran, and its connection was refused.
      assert.equal(result.exitCode, 3, result.output);
      assert.equal(connections, before);
    } finally {
      await new Promise((done) => server.close(done));
    }
  });
});

/** The first folder under /run that /etc/resolv.conf's real path is in, as the sandbox binds it. */
const resolverFolder = (): string | undefined => {
  try {
    const real = realpathSync('/etc/resolv.conf');
    return real.startsWith('/run/') ? real.split('/')[2] : undefined;
  } catch {
    return undefined;
  }
};

// A repository's setup in the same sandbox with the network kept (ADR 0158): it reaches a server,
// as an install reaches its registry, and still cannot read the home folder or write outside.
describe('a setup in the real sandbox, the network kept', {
  skip: setupUnavailable() ?? false,
}, () => {
  let dir: TempDir;
  let home: string;
  let worktree: string;
  let outside: string;
  let run: ReturnType<typeof sandboxedChecks>;
  const setup = (line: string) => {
    const { NODE_TEST_CONTEXT: _, ...env } = process.env;
    return run(line, [], { cwd: worktree, env, shell: true, timeoutMs: 60_000 });
  };

  before(() => {
    dir = makeTempDir('setup-sandbox');
    home = join(dir.path, 'home');
    worktree = join(dir.path, 'worktree');
    outside = join(dir.path, 'outside');
    for (const folder of [home, worktree, outside]) mkdirSync(folder);
    writeFileSync(join(home, 'secret.txt'), 'planted-login\n');
    run = sandboxedChecks({ exec: execProcess, home, network: true });
  });
  after(() => dir.remove());

  it('opens a connection to a server on 127.0.0.1 on macOS, whose profile keeps IP', {
    skip: process.platform !== 'darwin' && 'Linux gives a setup a network namespace of its own',
  }, async () => {
    const server = await counting((it, done) => it.listen(0, '127.0.0.1', done));
    try {
      const result = await setup(connectLine(`${server.port},'127.0.0.1'`));
      assert.equal(result.exitCode, 0, result.output);
      await waitUntil('the server saw the connection', () => server.connections() === 1);
    } finally {
      await server.close();
    }
  });

  // An install reaches its registry through the stack: here a server on an address of this
  // machine that is not the loopback, so nothing leaves the machine (CLAUDE.md).
  it('opens a connection through the stack on Linux, to an address that is not the loopback', {
    skip: process.platform !== 'linux' && 'the network stack is Linux only',
  }, async () => {
    const address = outsideAddress();
    if (address === undefined) {
      assert.ok(!inCi, 'CI has an address that is not the loopback');
      return;
    }
    const server = await counting((it, done) => it.listen(0, address, done));
    try {
      const result = await setup(connectLine(`${server.port},'${address}'`));
      assert.equal(result.exitCode, 0, result.output);
      await waitUntil('the server saw the connection', () => server.connections() === 1);
    } finally {
      await server.close();
    }
  });

  // The namespace is the setup's own: 127.0.0.1 is its own loopback, and the stack maps no
  // address to the host's (ADR 0218).
  it("cannot open a connection to a server on the host's 127.0.0.1 on Linux", {
    skip: process.platform !== 'linux' && 'the network namespace is Linux only',
  }, async () => {
    const server = await counting((it, done) => it.listen(0, '127.0.0.1', done));
    try {
      // The same line outside the sandbox reaches the server: the refusal is the sandbox's.
      const line = connectLine(`${server.port},'127.0.0.1'`);
      const open = await execProcess(line, [], { cwd: worktree, shell: true, timeoutMs: 60_000 });
      assert.equal(open.exitCode, 0, open.output);
      await waitUntil('the server saw the connection', () => server.connections() === 1);
      for (const host of ['127.0.0.1', '10.0.2.2']) {
        const result = await setup(connectLine(`${server.port},'${host}'`, 30_000));
        assert.equal(result.exitCode, 3, `${host}: ${result.output}`);
      }
      assert.equal(server.connections(), 1);
    } finally {
      await server.close();
    }
  });

  // An abstract socket belongs to the network namespace: an X server's, a D-Bus bus's (#425).
  it("cannot connect to the host's abstract Unix socket on Linux", {
    skip: process.platform !== 'linux' && 'abstract sockets are Linux only',
  }, async () => {
    const name = `foedrum-425-${process.pid}-${Date.now()}`;
    // node takes a path that starts with a NUL byte as an abstract name.
    const server = await counting((it, done) => it.listen(`\0${name}`, done));
    try {
      // The line's JavaScript writes the NUL as an escape, so no NUL byte is in the command line.
      const line = connectLine(`'\\\\0${name}'`);
      // The same line outside the sandbox reaches the socket: the refusal is the sandbox's.
      const open = await execProcess(line, [], { cwd: worktree, shell: true, timeoutMs: 60_000 });
      assert.equal(open.exitCode, 0, open.output);
      await waitUntil('the server saw the connection', () => server.connections() === 1);
      const result = await setup(line);
      assert.equal(result.exitCode, 3, result.output);
      assert.equal(server.connections(), 1);
    } finally {
      await server.close();
    }
  });
  it('cannot read a file in the home folder', async () => {
    writeFileSync(join(worktree, 'package.json'), '{}\n');
    const result = await setup(`cat package.json && cat "${home}/secret.txt"`);
    assert.match(result.output, /\{\}/);
    assert.notEqual(result.exitCode, 0, result.output);
    assert.doesNotMatch(result.output, /planted-login/);
  });

  it('writes in its worktree, and not outside it', async () => {
    const result = await setup(`echo in > installed.txt && echo out > "${outside}/x.txt"`);
    assert.notEqual(result.exitCode, 0, result.output);
    assert.ok(existsSync(join(worktree, 'installed.txt')), result.output);
    assert.ok(!existsSync(join(outside, 'x.txt')), result.output);
  });

  // Seatbelt's network* covers Unix sockets too, such as launchd's ssh-agent under /private/tmp
  // (review of #422): a setup keeps IP, not them.
  it('cannot connect to a Unix socket outside its worktree on macOS', {
    skip: process.platform !== 'darwin' && 'the profile is macOS only',
  }, async () => {
    // By relative paths: macOS caps a socket's path at 104 bytes, and a checkout can be deep.
    const server = createServer((socket) => socket.destroy());
    await new Promise<void>((done, fail) => {
      server.once('error', fail);
      server.listen(relative(process.cwd(), join(outside, 'a.sock')), done);
    });
    try {
      const connect = `require('net').connect('../outside/a.sock').on('connect',()=>process.exit(0)).on('error',()=>process.exit(3))`;
      const line = `"${process.execPath}" -e "${connect}"`;
      // The same line outside the sandbox reaches the socket: the refusal is the sandbox's.
      const open = await execProcess(line, [], { cwd: worktree, shell: true, timeoutMs: 60_000 });
      assert.equal(open.exitCode, 0, open.output);
      const result = await setup(line);
      assert.equal(result.exitCode, 3, result.output);
    } finally {
      await new Promise((done) => server.close(done));
    }
  });

  // macOS's resolver answers through mDNSResponder's socket, the one Unix socket a setup keeps
  // (review of #422); localhost needs no network.
  it('looks a name up on macOS', {
    skip: process.platform !== 'darwin' && 'the resolver socket is a macOS path',
  }, async () => {
    const lookup = `require('dns').lookup('localhost',(e)=>process.exit(e?3:0))`;
    const result = await setup(`"${process.execPath}" -e "${lookup}"`);
    assert.equal(result.exitCode, 0, result.output);
  });

  // An install looks its registry up by name, through the stack's resolver: the host's may be
  // systemd-resolved's 127.0.0.53, which in the namespace is its own loopback (ADR 0218).
  it("reads the stack's resolver at /etc/resolv.conf on Linux, also where it links into the hidden /run", {
    skip: process.platform !== 'linux' && 'the resolver file is a Linux path',
  }, async () => {
    const result = await setup('cat /etc/resolv.conf');
    assert.equal(result.exitCode, 0, result.output);
    assert.equal(result.stdout, 'nameserver 10.0.2.3\n');
  });

  // The query goes to the stack's 10.0.2.3, which slirp4netns answers under its seccomp filter
  // (ADR 0277) through the host's systemd-resolved, which answers localhost itself, so nothing
  // leaves the machine: a host with another resolver skips it before it sends the query, on CI's
  // ubuntu leg too, whose runners differ in their resolver (review of #702, #720).
  it("resolves a name through the stack's resolver on Linux", {
    skip: resolverSkip() ?? false,
  }, async () => {
    const query = `require('dns').resolve4('localhost',(e,a)=>process.exit(!e&&a.includes('127.0.0.1')?0:3))`;
    const result = await setup(`"${process.execPath}" -e "${query}"`);
    assert.equal(result.exitCode, 0, result.output);
  });

  it('sees no user folder under /run on Linux, where the D-Bus socket was', {
    skip: process.platform !== 'linux' && 'the keyring socket is a Linux path',
  }, async () => {
    const result = await setup('ls -A /run');
    assert.equal(result.exitCode, 0, result.output);
    // Only the folder of the stack's resolver file, where /etc/resolv.conf links into /run
    // (ADR 0218): systemd-resolved, resolvconf or NetworkManager, as the machine has it.
    assert.equal(result.output.trim(), resolverFolder() ?? '');
  });
});

/** The devices of a line of /proc/<pid>/mountinfo: its third field, `major:minor`. */
const mountDevices = (mountinfo: string): Set<string> =>
  new Set(mountinfo.split('\n').flatMap((line) => line.split(' ')[2] ?? []));

/**
 * The device of the mount that holds `path`, as the test's own mountinfo writes it: the line whose
 * mount point (the fifth field) is the longest that contains the path, the last of equals. Read
 * from mountinfo, not from stat, whose device is a btrfs subvolume's own.
 */
const deviceOf = (path: string): string => {
  const real = realpathSync(path);
  const holds = (point: string) => point === '/' || real === point || real.startsWith(`${point}/`);
  const mounts = readFileSync('/proc/self/mountinfo', 'utf8')
    .split('\n')
    .map((line) => line.split(' '))
    .filter((fields) => fields[4] !== undefined && holds(fields[4]));
  const longest = Math.max(...mounts.map((fields) => (fields[4] ?? '').length));
  return mounts.findLast((fields) => (fields[4] ?? '').length === longest)?.[2] ?? '';
};

/**
 * The pids of `tool`'s processes started for the setup whose line holds `marker`: the stack's
 * arguments name the pid of bwrap's child, whose own arguments hold the line.
 */
const stackPids = (tool: NetworkStackTool, marker: string): number[] =>
  readdirSync('/proc')
    .filter((entry) => /^\d+$/.test(entry))
    .filter((entry) => {
      try {
        const args = readFileSync(`/proc/${entry}/cmdline`, 'utf8').split('\0');
        // Ubuntu's pasta runs as pasta.avx2 where the processor has it.
        if (!basename(args[0] ?? '').startsWith(tool)) return false;
        // pasta ends with the pid, slirp4netns with the pid and its tap device.
        const target = args.filter((arg) => arg !== '').at(tool === 'pasta' ? -1 : -2);
        return readFileSync(`/proc/${target}/cmdline`, 'utf8').includes(marker);
      } catch {
        // Ended while it was read.
        return false;
      }
    })
    .map(Number);

/** The link a process's namespace has under /proc, or undefined when it cannot be read. */
const namespaceOf = (pid: number | 'self'): string | undefined => {
  try {
    return readlinkSync(`/proc/${pid}/ns/mnt`);
  } catch {
    // A process that made itself undumpable keeps its namespaces from other users' processes.
    return undefined;
  }
};

// What a setup's stack can see of the host's files as Foedrum starts it (ADR 0400): pasta
// detaches into a mount namespace of its own on an empty root, and slirp4netns keeps the user's,
// with the home folder and /run/user in it. Each stack is the only one found, so the run goes
// through the same code as a setup's. On CI's Linux leg a missing stack fails instead of skipping.
describe("what a setup's network stack can see of the host's files", {
  skip: process.platform !== 'linux' ? 'the stacks are Linux only' : (skip ?? false),
}, () => {
  let dir: TempDir;

  before(() => {
    dir = makeTempDir('stack-sees');
  });

  after(() => dir.remove());

  /**
   * Runs a setup whose line waits for the test, and reads the mounts of the stack's process
   * while it does; the line ends once the test has read them.
   */
  const whileStackRuns = async (tool: NetworkStackTool) => {
    const home = join(dir.path, tool, 'home');
    const worktree = join(dir.path, tool, 'worktree');
    for (const folder of [home, worktree]) mkdirSync(folder, { recursive: true });
    writeFileSync(join(home, 'secret.txt'), 'planted-login\n');
    const run = sandboxedChecks({
      exec: execProcess,
      home,
      network: true,
      findStackTool: (name) => (name === tool ? resolveExecutable(name) : undefined),
    });
    const { NODE_TEST_CONTEXT: _, ...env } = process.env;
    const marker = `stack-sees-${tool}-${process.pid}`;
    let ended = false;
    const line = `: ${marker}; touch started; while [ ! -e release ]; do sleep 0.1; done`;
    const running = run(line, [], {
      cwd: worktree,
      env,
      shell: true,
      timeoutMs: 60_000,
    }).finally(() => {
      ended = true;
    });
    await waitUntil(
      'the setup line to start',
      () => ended || existsSync(join(worktree, 'started')),
    );
    const pids = stackPids(tool, marker);
    const seen = pids.map((pid) => ({
      mountinfo: readFileSync(`/proc/${pid}/mountinfo`, 'utf8'),
      namespace: namespaceOf(pid),
    }));
    writeFileSync(join(worktree, 'release'), '');
    const result = await running;
    assert.equal(result.exitCode, 0, result.output);
    assert.equal(seen.length, 1, `${tool}'s processes for this setup: ${pids.join(', ')}`);
    const userRun = `/run/user/${process.getuid?.()}`;
    const hidden = [join(home, 'secret.txt'), existsSync(userRun) ? userRun : '/run'];
    return { seen: seen[0], devices: hidden.map(deviceOf) };
  };

  const stackSkip = (tool: NetworkStackTool) =>
    inCi || resolveExecutable(tool) !== undefined ? false : `${tool} is not on PATH`;

  it('runs pasta in a mount namespace of its own, without the home folder or /run/user', {
    skip: stackSkip('pasta'),
  }, async (t) => {
    const { seen, devices } = await whileStackRuns('pasta');
    const mounted = mountDevices(seen?.mountinfo ?? '');
    assert.notEqual(seen?.mountinfo.trim(), '');
    for (const device of devices) assert.ok(!mounted.has(device), seen?.mountinfo);
    // pasta makes itself undumpable, which may keep its namespace link from the test.
    t.diagnostic(`pasta's mount namespace: ${seen?.namespace ?? 'cannot be read'}`);
    assert.notEqual(seen?.namespace, namespaceOf('self'));
  });

  // The gap ADR 0400 accepts for now: a taken-over slirp4netns reaches what the user does.
  it("runs slirp4netns in the user's mount namespace, with the home folder and /run/user", {
    skip: stackSkip('slirp4netns'),
  }, async () => {
    const { seen, devices } = await whileStackRuns('slirp4netns');
    const mounted = mountDevices(seen?.mountinfo ?? '');
    for (const device of devices) assert.ok(mounted.has(device), seen?.mountinfo);
    assert.equal(seen?.namespace, namespaceOf('self'));
  });
});
