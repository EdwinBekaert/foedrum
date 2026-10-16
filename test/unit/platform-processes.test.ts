import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import {
  type ChildHandle,
  DEFAULT_MAX_OUTPUT_BYTES,
  type ExecProcess,
  type ExecResult,
  execProcessWith,
  isPidAlive,
  type Kill,
  killProcessTree,
  runProcessThrough,
  type Spawner,
  spawnCommand,
  stopOnSignals,
  type Timers,
  whyKilled,
} from '../../src/platform/processes.ts';

const failingWith =
  (code: string): Kill =>
  () => {
    throw Object.assign(new Error(code), { code });
  };

describe('isPidAlive', () => {
  it('is true when signal 0 reaches the process', () => {
    assert.equal(
      isPidAlive(42, () => undefined),
      true,
    );
  });

  it('is false when the process does not exist', () => {
    assert.equal(isPidAlive(42, failingWith('ESRCH')), false);
  });

  // A live session of another user must not look ended, or its worktree would be removed.
  it('is true when the process exists but belongs to someone else', () => {
    assert.equal(isPidAlive(42, failingWith('EPERM')), true);
  });

  it('is true for the current process', () => {
    assert.equal(isPidAlive(process.pid), true);
  });
});

describe('killProcessTree', () => {
  const recorder = () => {
    const signals: [number, string][] = [];
    const taskkills: number[] = [];
    return {
      signals,
      taskkills,
      signal: (pid: number, signal: NodeJS.Signals) => {
        signals.push([pid, signal]);
      },
      taskkill: (pid: number) => {
        taskkills.push(pid);
      },
    };
  };

  // A clock whose timers run only when the test says so.
  const clock = () => {
    const pending: { callback: () => void; ms: number }[] = [];
    const timers: Timers = {
      set: (callback, ms) => {
        pending.push({ callback, ms });
        return pending.length;
      },
      clear: () => {},
    };
    const fire = () => {
      for (const { callback } of pending.splice(0)) callback();
    };
    return { pending, timers, fire };
  };

  it('runs taskkill for the whole tree on Windows', () => {
    const r = recorder();
    const c = clock();
    killProcessTree(42, {
      platform: 'win32',
      signal: r.signal,
      taskkill: r.taskkill,
      timers: c.timers,
    });
    assert.deepEqual(r.taskkills, [42]);
    assert.deepEqual(r.signals, []);
    assert.deepEqual(c.pending, []);
  });

  // A process that leads a group asks no one else to stop: npm run check, killed by the gate,
  // kills its own steps' groups on SIGTERM, which SIGKILL would not let it do.
  for (const platform of ['linux', 'darwin'] as const) {
    it(`asks the process group to stop on ${platform}, and kills it after 2 to 3 s`, () => {
      const r = recorder();
      const c = clock();
      killProcessTree(42, { platform, signal: r.signal, taskkill: r.taskkill, timers: c.timers });
      assert.deepEqual(r.signals, [[-42, 'SIGTERM']]);
      assert.equal(c.pending.length, 1);
      const graceMs = c.pending[0]?.ms ?? 0;
      assert.ok(graceMs >= 2000 && graceMs <= 3000, String(graceMs));
      c.fire();
      assert.deepEqual(r.signals, [
        [-42, 'SIGTERM'],
        [-42, 'SIGKILL'],
      ]);
      assert.deepEqual(r.taskkills, []);
    });
  }

  it('signals the process itself when it leads no group', () => {
    const r = recorder();
    const c = clock();
    const signal = (pid: number, name: NodeJS.Signals) => {
      r.signal(pid, name);
      if (pid < 0) throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
    };
    killProcessTree(42, { platform: 'linux', signal, taskkill: r.taskkill, timers: c.timers });
    assert.deepEqual(r.signals, [
      [-42, 'SIGTERM'],
      [42, 'SIGTERM'],
    ]);
    c.fire();
    // Only the process that took the SIGTERM: the group was never there.
    assert.deepEqual(r.signals.slice(2), [[42, 'SIGKILL']]);
  });

  // By the time of the SIGKILL the system may have given the pid to an unrelated process.
  it('sends SIGKILL to nothing else when the group that took the SIGTERM is gone', () => {
    const r = recorder();
    const c = clock();
    let groupGone = false;
    const signal = (pid: number, name: NodeJS.Signals) => {
      if (pid < 0 && groupGone) throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
      r.signal(pid, name);
    };
    killProcessTree(42, { platform: 'linux', signal, timers: c.timers });
    groupGone = true;
    c.fire();
    assert.deepEqual(r.signals, [[-42, 'SIGTERM']]);
  });

  it('ignores a process that is already gone', () => {
    const c = clock();
    const signal = () => {
      throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
    };
    assert.doesNotThrow(() => killProcessTree(42, { platform: 'linux', signal, timers: c.timers }));
    assert.deepEqual(c.pending, []);
  });

  it('ignores a process that ends during the grace period', () => {
    const c = clock();
    let gone = false;
    const signal = () => {
      if (gone) throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
    };
    killProcessTree(42, { platform: 'linux', signal, timers: c.timers });
    gone = true;
    assert.doesNotThrow(() => c.fire());
  });
});

// A started process that does what the test tells it to; no real process runs (ADR 0021).
// 'none' is a program that did not start, which has no pid.
class FakeChild extends EventEmitter implements ChildHandle {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly pid: number | undefined;
  constructor(pid: number | 'none' = 4242) {
    super();
    this.pid = pid === 'none' ? undefined : pid;
  }
  close(code: number | null): void {
    this.stdout.end();
    this.stderr.end();
    this.emit('close', code);
  }
}

const fakeSpawner = (child: FakeChild | Error = new FakeChild()) => {
  const spawned: { file: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv }[] = [];
  const killed: number[] = [];
  const spawner: Spawner = {
    spawn: (file, args, { cwd, env }) => {
      spawned.push({ file, args, cwd, env });
      if (child instanceof Error) throw child;
      return child;
    },
    killTree: (pid) => {
      killed.push(pid);
    },
  };
  return { spawned, killed, spawner, exec: execProcessWith(spawner) };
};

// Lets the stream events that are already queued run.
const settle = () => new Promise((resolve) => setImmediate(resolve));

describe('execProcessWith', () => {
  it('starts the program with its arguments, directory and environment', async () => {
    const child = new FakeChild();
    const { spawned, exec } = fakeSpawner(child);
    const done = exec('git', ['status'], { cwd: '/work/tree', env: { PATH: '/bin' } });
    child.close(0);
    await done;
    assert.deepEqual(spawned, [
      { file: 'git', args: ['status'], cwd: '/work/tree', env: { PATH: '/bin' } },
    ]);
  });

  it("uses this process's environment by default", async () => {
    const child = new FakeChild();
    const { spawned, exec } = fakeSpawner(child);
    const done = exec('git', [], { cwd: '/work/tree' });
    child.close(0);
    await done;
    assert.equal(spawned[0]?.env, process.env);
  });

  it('answers with the exit code, stdout and stderr apart, and both in the order they came', async () => {
    const child = new FakeChild();
    const { exec } = fakeSpawner(child);
    const done = exec('npm', ['test'], { cwd: '/work/tree' });
    child.stdout.write('one\n');
    await settle();
    child.stderr.write('two\n');
    await settle();
    child.stdout.write('three\n');
    await settle();
    child.close(3);
    assert.deepEqual(await done, {
      exitCode: 3,
      stdout: 'one\nthree\n',
      stderr: 'two\n',
      output: 'one\ntwo\nthree\n',
    });
  });

  it('keeps a character whose bytes arrive in two chunks', async () => {
    const child = new FakeChild();
    const { exec } = fakeSpawner(child);
    const done = exec('npm', ['test'], { cwd: '/work/tree' });
    const bytes = Buffer.from('café', 'utf8');
    child.stdout.write(bytes.subarray(0, 4));
    child.stdout.write(bytes.subarray(4));
    await settle();
    child.close(0);
    assert.equal((await done).stdout, 'café');
  });

  it('answers without an exit code, with the reason, when the program cannot start', async () => {
    const child = new FakeChild('none');
    const { exec } = fakeSpawner(child);
    const done = exec('nope', [], { cwd: '/work/tree' });
    child.emit('error', new Error('spawn nope ENOENT'));
    const result = await done;
    assert.equal(result.exitCode, null);
    assert.equal(result.output, 'spawn nope ENOENT');
    assert.equal(result.stderr, 'spawn nope ENOENT');
    assert.equal(result.killed, undefined);
  });

  it('keeps what the process wrote and adds the reason when it fails afterwards', async () => {
    const child = new FakeChild();
    const { exec } = fakeSpawner(child);
    const done = exec('git', ['fetch'], { cwd: '/work/tree' });
    child.stderr.write('remote: counting\n');
    await settle();
    child.emit('error', new Error('read EPIPE'));
    const result = await done;
    assert.equal(result.exitCode, null);
    assert.equal(result.stderr, 'remote: counting\nread EPIPE');
    assert.equal(result.output, 'remote: counting\nread EPIPE');
  });

  it('answers without an exit code, with the reason, when spawn itself throws', async () => {
    const { exec } = fakeSpawner(new Error('spawn EINVAL'));
    const result = await exec('claude.cmd', [], { cwd: '/work/tree' });
    assert.equal(result.exitCode, null);
    assert.equal(result.output, 'spawn EINVAL');
  });

  // On Windows a bare name would be looked up in the child's working directory first, where a
  // repository can plant its own git.exe (#12).
  it('starts the file the spawner resolves the name to, in its environment', async () => {
    const child = new FakeChild();
    const { spawned, spawner } = fakeSpawner(child);
    const resolved: [string, NodeJS.ProcessEnv][] = [];
    const exec = execProcessWith({
      ...spawner,
      resolve: (file, env) => {
        resolved.push([file, env]);
        return 'C:\\Program Files\\Git\\cmd\\git.exe';
      },
    });
    const env = { PATH: 'C:\\Program Files\\Git\\cmd' };
    const done = exec('git', ['status'], { cwd: 'D:\\work\\tree', env });
    child.close(0);
    await done;
    assert.deepEqual(resolved, [['git', env]]);
    assert.equal(spawned[0]?.file, 'C:\\Program Files\\Git\\cmd\\git.exe');
  });

  it('starts nothing, and says so, when the name resolves to no file', async () => {
    const child = new FakeChild();
    const { spawned, spawner } = fakeSpawner(child);
    const exec = execProcessWith({ ...spawner, resolve: () => undefined });
    const done = exec('git', ['status'], { cwd: '/work/tree' });
    // Ends a child that was started all the same, so the test fails instead of waiting.
    await settle();
    child.close(0);
    const result = await done;
    assert.deepEqual(spawned, []);
    assert.equal(result.exitCode, null);
    assert.match(result.output, /git: not found on PATH/);
    assert.equal(result.stderr, result.output);
  });

  describe('with a deadline', () => {
    beforeEach(() => mock.timers.enable({ apis: ['setTimeout'] }));
    afterEach(() => mock.timers.reset());

    it('kills the whole tree at the deadline and answers at once, as timed out', async () => {
      const child = new FakeChild(77);
      const { killed, exec } = fakeSpawner(child);
      let result: ExecResult | undefined;
      const done = exec('npm', ['test'], { cwd: '/work/tree', timeoutMs: 1000 }).then((r) => {
        result = r;
      });
      child.stdout.write('started\n');
      await settle();
      mock.timers.tick(999);
      await settle();
      assert.deepEqual(killed, []);
      assert.equal(result, undefined);
      // The child's output pipes stay open: a grandchild may hold them.
      mock.timers.tick(1);
      await done;
      assert.deepEqual(killed, [77]);
      assert.deepEqual(result, {
        exitCode: null,
        stdout: 'started\n',
        stderr: '',
        output: 'started\n',
        killed: 'timed-out',
      });
      assert.ok(child.stdout.destroyed && child.stderr.destroyed, 'stops reading its output');
    });

    it('kills nothing once the process has ended', async () => {
      const child = new FakeChild();
      const { killed, exec } = fakeSpawner(child);
      const done = exec('npm', ['test'], { cwd: '/work/tree', timeoutMs: 1000 });
      child.close(0);
      assert.equal((await done).killed, undefined);
      mock.timers.tick(5000);
      assert.deepEqual(killed, []);
    });

    it('answers once, as timed out, when the process closes after being killed', async () => {
      const child = new FakeChild();
      const { killed, exec } = fakeSpawner(child);
      const done = exec('npm', ['test'], { cwd: '/work/tree', timeoutMs: 10 });
      mock.timers.tick(10);
      child.emit('close', null);
      assert.equal((await done).killed, 'timed-out');
      assert.equal(killed.length, 1);
    });

    it('kills nothing at the deadline when the program never started', async () => {
      const child = new FakeChild('none');
      const { killed, exec } = fakeSpawner(child);
      const done = exec('npm', ['test'], { cwd: '/work/tree', timeoutMs: 10 });
      mock.timers.tick(10);
      assert.equal((await done).killed, 'timed-out');
      assert.deepEqual(killed, []);
    });
  });

  it('kills the whole tree when the signal aborts and answers at once, as stopped', async () => {
    const child = new FakeChild(78);
    const { killed, exec } = fakeSpawner(child);
    const stop = new AbortController();
    const done = exec('npm', ['test'], { cwd: '/work/tree', signal: stop.signal });
    child.stderr.write('partial\n');
    await settle();
    stop.abort();
    const result = await done;
    assert.deepEqual(killed, [78]);
    assert.equal(result.killed, 'stopped');
    assert.equal(result.exitCode, null);
    assert.equal(result.output, 'partial\n');
  });

  // A hook or a diff of untrusted content can write without end; the deadline does not bound
  // the memory that takes (#91).
  describe('with an output limit', () => {
    it('kills the whole tree when stdout and stderr together pass it, and answers at once', async () => {
      const child = new FakeChild(79);
      const { killed, exec } = fakeSpawner(child);
      const done = exec('git', ['log', '-p'], { cwd: '/work/tree', maxOutputBytes: 10 });
      child.stdout.write('12345');
      await settle();
      child.stderr.write('678');
      await settle();
      assert.deepEqual(killed, []);
      child.stdout.write('abc');
      await settle();
      // Ends a child the runner did not kill, so the test fails instead of waiting.
      child.close(0);
      // What came within the limit; never the chunk that passed it.
      assert.deepEqual(await done, {
        exitCode: null,
        stdout: '12345',
        stderr: '678',
        output: '12345678',
        killed: 'too-much-output',
      });
      assert.deepEqual(killed, [79]);
      assert.ok(child.stdout.destroyed && child.stderr.destroyed, 'stops reading its output');
    });

    it('counts bytes, not characters', async () => {
      const child = new FakeChild();
      const { exec } = fakeSpawner(child);
      const done = exec('git', ['log'], { cwd: '/work/tree', maxOutputBytes: 7 });
      // Four characters, eight bytes.
      child.stdout.write('éééé');
      await settle();
      child.close(0);
      assert.equal((await done).killed, 'too-much-output');
    });

    it('is 4 MiB when the caller gives none', async () => {
      const child = new FakeChild(80);
      const { killed, exec } = fakeSpawner(child);
      const done = exec('git', ['log', '-p'], { cwd: '/work/tree' });
      child.stdout.write('x'.repeat(DEFAULT_MAX_OUTPUT_BYTES));
      await settle();
      assert.deepEqual(killed, []);
      child.stderr.write('y');
      await settle();
      child.close(0);
      const result = await done;
      assert.equal(result.killed, 'too-much-output');
      assert.equal(result.output.length, 4 * 1024 * 1024);
      assert.deepEqual(killed, [80]);
    });
  });

  it('starts nothing when the signal has already aborted', async () => {
    const { spawned, exec } = fakeSpawner();
    const result = await exec('npm', ['test'], { cwd: '/work/tree', signal: AbortSignal.abort() });
    assert.deepEqual(spawned, []);
    assert.equal(result.killed, 'stopped');
    assert.equal(result.exitCode, null);
  });

  it('kills nothing when the signal aborts after the process ended', async () => {
    const child = new FakeChild();
    const { killed, exec } = fakeSpawner(child);
    const stop = new AbortController();
    const done = exec('npm', ['test'], { cwd: '/work/tree', signal: stop.signal });
    child.close(0);
    await done;
    stop.abort();
    assert.deepEqual(killed, []);
  });
});

// A deadline left running keeps node alive after the process ended: the worktree cleanup would
// wait out git's 60 s, npm run check its 300 s.
describe('execProcessWith and its clock', () => {
  const fakeTimers = () => {
    const pending = new Map<number, number>();
    let next = 0;
    const timers: Timers = {
      set: (_callback, ms) => {
        next += 1;
        pending.set(next, ms);
        return next;
      },
      clear: (timer) => {
        pending.delete(timer as number);
      },
    };
    return { pending, timers };
  };

  it('sets the deadline on the given clock and clears it once the process has ended', async () => {
    const child = new FakeChild();
    const { pending, timers } = fakeTimers();
    const exec = execProcessWith(fakeSpawner(child).spawner, timers);
    const done = exec('git', ['fetch'], { cwd: '/work/tree', timeoutMs: 60_000 });
    assert.deepEqual([...pending.values()], [60_000]);
    child.close(0);
    await done;
    assert.equal(pending.size, 0);
  });

  it('sets no deadline without a timeout', async () => {
    const child = new FakeChild();
    const { pending, timers } = fakeTimers();
    const done = execProcessWith(fakeSpawner(child).spawner, timers)('git', [], {
      cwd: '/work/tree',
    });
    assert.equal(pending.size, 0);
    child.close(0);
    await done;
  });
});

describe('stopOnSignals', () => {
  const listening = () => {
    const handlers = new Map<string, () => void>();
    return {
      handlers,
      listen: (name: NodeJS.Signals, handler: () => void) => {
        handlers.set(name, handler);
      },
    };
  };

  it('listens for Ctrl+C, a closed terminal, a catchable kill and Ctrl+Break', () => {
    const { handlers, listen } = listening();
    stopOnSignals(listen);
    assert.deepEqual([...handlers.keys()].sort(), ['SIGBREAK', 'SIGHUP', 'SIGINT', 'SIGTERM']);
  });

  for (const name of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK'] as const) {
    it(`aborts when ${name} comes`, () => {
      const { handlers, listen } = listening();
      const signal = stopOnSignals(listen);
      assert.equal(signal.aborted, false);
      handlers.get(name)?.();
      assert.equal(signal.aborted, true);
    });
  }
});

describe('runProcessThrough', () => {
  it('runs the program in the directory with the deadline and signal, output together', async () => {
    const calls: Parameters<ExecProcess>[] = [];
    const exec: ExecProcess = async (...call) => {
      calls.push(call);
      return { exitCode: null, stdout: 'a', stderr: 'b', output: 'ab', killed: 'timed-out' };
    };
    const signal = new AbortController().signal;
    const outcome = await runProcessThrough(exec)('node', ['x.ts'], '/work/tree', {
      timeoutMs: 5,
      signal,
      maxOutputBytes: 64,
    });
    assert.deepEqual(calls, [
      ['node', ['x.ts'], { cwd: '/work/tree', timeoutMs: 5, signal, maxOutputBytes: 64 }],
    ]);
    assert.deepEqual(outcome, { exitCode: null, output: 'ab', killed: 'timed-out' });
  });

  it('leaves out killed for a process that ended by itself', async () => {
    const exec: ExecProcess = async () => ({ exitCode: 0, stdout: 'a', stderr: '', output: 'a' });
    assert.deepEqual(await runProcessThrough(exec)('node', [], '/work/tree'), {
      exitCode: 0,
      output: 'a',
    });
  });
});

describe('whyKilled', () => {
  it('names the output limit, 4 MiB unless the caller gave another', () => {
    assert.equal(whyKilled('too-much-output', 1000), 'wrote more than 4 MiB of output');
    assert.equal(
      whyKilled('too-much-output', 1000, 512 * 1024 * 1024),
      'wrote more than 512 MiB of output',
    );
    assert.equal(whyKilled('too-much-output', 1000, 64 * 1024), 'wrote more than 64 KiB of output');
    assert.equal(whyKilled('too-much-output', 1000, 1500), 'wrote more than 1500 bytes of output');
  });
});

describe('spawnCommand', () => {
  const env = { PATH: 'C:\\nodejs', SystemRoot: 'D:\\WINDOWS' };
  // cmd.exe by its full path, never through ComSpec or a lookup that could find a planted one.
  const cmd = 'D:\\WINDOWS\\System32\\cmd.exe';
  // cmd.exe then also skips the working directory when the .cmd file runs a bare `node` (#12).
  const shellEnv = { ...env, NoDefaultCurrentDirectoryInExePath: '1' };

  it('starts a program directly, without a shell, in the environment it was given', () => {
    assert.deepEqual(spawnCommand('/usr/bin/git', ['--version'], 'linux', env), {
      file: '/usr/bin/git',
      args: ['--version'],
      shell: false,
      env,
    });
    assert.deepEqual(spawnCommand('C:\\Git\\cmd\\git.exe', ['--version'], 'win32', env), {
      file: 'C:\\Git\\cmd\\git.exe',
      args: ['--version'],
      shell: false,
      env,
    });
  });

  it('starts a .cmd or .bat file on Windows through cmd.exe, every part quoted', () => {
    // npm.cmd and npm's claude.cmd cannot start without a shell (architecture §13).
    const npm = 'C:\\Program Files\\nodejs\\npm.cmd';
    assert.deepEqual(spawnCommand(npm, ['--version'], 'win32', env), {
      file: '"C:\\Program Files\\nodejs\\npm.cmd" "--version"',
      args: [],
      shell: cmd,
      env: shellEnv,
    });
    assert.deepEqual(spawnCommand('C:\\tools\\RUN.BAT', [], 'win32', env), {
      file: '"C:\\tools\\RUN.BAT"',
      args: [],
      shell: cmd,
      env: shellEnv,
    });
  });

  it('reads SystemRoot whatever the case of its name, as Windows does', () => {
    // Git Bash exports it as SYSTEMROOT; a copied environment keeps that spelling.
    assert.equal(
      spawnCommand('C:\\tools\\run.cmd', [], 'win32', { SYSTEMROOT: 'D:\\Windows' }).shell,
      'D:\\Windows\\System32\\cmd.exe',
    );
  });

  it('finds cmd.exe in C:\\Windows when SystemRoot is not set', () => {
    assert.equal(
      spawnCommand('C:\\tools\\run.cmd', [], 'win32', { PATH: 'C:\\nodejs' }).shell,
      'C:\\Windows\\System32\\cmd.exe',
    );
  });

  it('starts a .cmd file elsewhere as any other file', () => {
    assert.deepEqual(spawnCommand('/opt/tools/run.cmd', ['a'], 'darwin', env), {
      file: '/opt/tools/run.cmd',
      args: ['a'],
      shell: false,
      env,
    });
  });

  it('refuses an argument cmd.exe would read as syntax', () => {
    assert.throws(
      () => spawnCommand('C:\\nodejs\\npm.cmd', ['a & calc'], 'win32'),
      /argument 1 "a & calc" cannot go through the Windows shell/,
    );
  });
});
