import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import {
  type ChildHandle,
  type ExecProcess,
  type ExecResult,
  execProcessWith,
  isPidAlive,
  type Kill,
  killProcessTree,
  runProcessThrough,
  type Spawner,
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

  it('runs taskkill for the whole tree on Windows', () => {
    const r = recorder();
    killProcessTree(42, { platform: 'win32', signal: r.signal, taskkill: r.taskkill });
    assert.deepEqual(r.taskkills, [42]);
    assert.deepEqual(r.signals, []);
  });

  for (const platform of ['linux', 'darwin'] as const) {
    it(`kills the process group on ${platform}`, () => {
      const r = recorder();
      killProcessTree(42, { platform, signal: r.signal, taskkill: r.taskkill });
      assert.deepEqual(r.signals, [[-42, 'SIGKILL']]);
      assert.deepEqual(r.taskkills, []);
    });
  }

  it('kills the process itself when it leads no group', () => {
    const r = recorder();
    const signal = (pid: number, name: NodeJS.Signals) => {
      r.signal(pid, name);
      if (pid < 0) throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
    };
    killProcessTree(42, { platform: 'linux', signal, taskkill: r.taskkill });
    assert.deepEqual(r.signals, [
      [-42, 'SIGKILL'],
      [42, 'SIGKILL'],
    ]);
  });

  it('ignores a process that is already gone', () => {
    const signal = () => {
      throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
    };
    assert.doesNotThrow(() => killProcessTree(42, { platform: 'linux', signal }));
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

  it('answers without an exit code, with the reason, when spawn itself throws', async () => {
    const { exec } = fakeSpawner(new Error('spawn EINVAL'));
    const result = await exec('claude.cmd', [], { cwd: '/work/tree' });
    assert.equal(result.exitCode, null);
    assert.equal(result.output, 'spawn EINVAL');
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
    });
    assert.deepEqual(calls, [['node', ['x.ts'], { cwd: '/work/tree', timeoutMs: 5, signal }]]);
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
