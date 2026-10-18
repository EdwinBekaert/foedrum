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
  shellCommand,
  spawnCommand,
  stopOnSignals,
  streamProcessWith,
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
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly pid: number | undefined;
  constructor(pid: number | 'none' = 4242) {
    super();
    this.pid = pid === 'none' ? undefined : pid;
  }
  close(code: number | null, signal: NodeJS.Signals | null = null): void {
    this.stdout.end();
    this.stderr.end();
    this.emit('close', code, signal);
  }
}

const fakeSpawner = (child: FakeChild | Error = new FakeChild()) => {
  const spawned: {
    file: string;
    args: string[];
    cwd: string;
    env: NodeJS.ProcessEnv;
    shell?: boolean;
    stdin?: boolean;
  }[] = [];
  const killed: number[] = [];
  const spawner: Spawner = {
    spawn: (file, args, { cwd, env, shell, stdin }) => {
      spawned.push({
        file,
        args,
        cwd,
        env,
        ...(shell === undefined ? {} : { shell }),
        ...(stdin === undefined ? {} : { stdin }),
      });
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

  it('writes its input to stdin and closes it, asking for a pipe only then', async () => {
    const child = new FakeChild();
    const { spawned, exec } = fakeSpawner(child);
    let input = '';
    child.stdin.setEncoding('utf8').on('data', (chunk: string) => {
      input += chunk;
    });
    let ended = false;
    child.stdin.on('finish', () => {
      ended = true;
    });
    const done = exec('gh', ['api', '--input', '-'], { cwd: '/work', stdin: '{"body":"✓"}' });
    await settle();
    child.close(0);
    await done;
    await settle();
    assert.equal(input, '{"body":"✓"}');
    assert.equal(ended, true);
    const plain = new FakeChild();
    const second = fakeSpawner(plain);
    const without = second.exec('git', [], { cwd: '/work' });
    plain.close(0);
    await without;
    assert.deepEqual(
      [spawned[0]?.stdin === true, second.spawned[0]?.stdin === true],
      [true, false],
    );
  });

  // gh may exit before reading its stdin (a refused argument); the write then fails with EPIPE,
  // which must not crash the engine.
  it('answers from how the process ended when its stdin cannot be written', async () => {
    const child = new FakeChild();
    const { exec } = fakeSpawner(child);
    const done = exec('gh', [], { cwd: '/work', stdin: 'body' });
    child.stdin.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }));
    child.stderr.write('unknown flag');
    child.close(1);
    assert.deepEqual(await done, {
      exitCode: 1,
      stdout: '',
      stderr: 'unknown flag',
      output: 'unknown flag',
    });
  });

  // A program that runs without its input would answer something else (#128).
  it('answers as not started, and ends the tree, when stdin was given but has no pipe', async () => {
    const child = new FakeChild(77);
    Object.assign(child, { stdin: null });
    const { killed, exec } = fakeSpawner(child);
    const done = exec('gh', [], { cwd: '/work', stdin: 'body' });
    child.stdout.write('HTTP/1.1 200 OK\n');
    await settle();
    child.close(0);
    const result = await done;
    assert.equal(result.exitCode, null);
    assert.equal(result.killed, undefined);
    assert.match(result.stderr, /^gh: no pipe to its stdin/);
    assert.deepEqual(killed, [77]);
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

  // A crash or the OOM killer: the process ran, and something other than the runner ended it.
  it('answers with the signal that ended the process when the runner did not send it', async () => {
    const child = new FakeChild();
    const { exec } = fakeSpawner(child);
    const done = exec('/bin/sh', ['-c', 'node --test'], { cwd: '/work/tree' });
    child.stdout.write('ok 1\n');
    await settle();
    child.close(null, 'SIGSEGV');
    assert.deepEqual(await done, {
      exitCode: null,
      stdout: 'ok 1\n',
      stderr: '',
      output: 'ok 1\n',
      signal: 'SIGSEGV',
    });
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

  // A check's command is a line for the platform shell, not a program to look up (ADR 0069).
  it('starts a command line through the shell as it is, without resolving it', async () => {
    const child = new FakeChild();
    const { spawned, spawner } = fakeSpawner(child);
    const resolved: string[] = [];
    const exec = execProcessWith({
      ...spawner,
      resolve: (file) => {
        resolved.push(file);
        return file;
      },
    });
    const done = exec('npm test', [], { cwd: '/work/tree', env: { PATH: '/bin' }, shell: true });
    child.close(0);
    await done;
    assert.deepEqual(resolved, []);
    assert.deepEqual(spawned, [
      { file: 'npm test', args: [], cwd: '/work/tree', env: { PATH: '/bin' }, shell: true },
    ]);
  });

  it('starts nothing, and says so, when a command line comes with arguments', async () => {
    const child = new FakeChild();
    const { spawned, exec } = fakeSpawner(child);
    const done = exec('npm test', ['--watch'], { cwd: '/work/tree', shell: true });
    // Ends a child that was started all the same, so the test fails instead of waiting.
    await settle();
    child.close(0);
    const result = await done;
    assert.deepEqual(spawned, []);
    assert.equal(result.exitCode, null);
    assert.match(result.output, /a command line for the shell takes no arguments/);
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

    it('lets a process that writes exactly the limit end by itself', async () => {
      const child = new FakeChild();
      const { killed, exec } = fakeSpawner(child);
      const done = exec('git', ['log'], { cwd: '/work/tree', maxOutputBytes: 4 });
      child.stdout.write('ab');
      child.stderr.write('é');
      await settle();
      child.close(0);
      assert.deepEqual(await done, { exitCode: 0, stdout: 'ab', stderr: 'é', output: 'abé' });
      assert.deepEqual(killed, []);
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

  describe('in a Job Object', () => {
    // A spawner that holds processes in jobs, as the real one does on Windows (ADR 0039).
    const jobSpawner = (child: FakeChild, jobObjects = true) => {
      const asked: (boolean | undefined)[] = [];
      const exec = execProcessWith({
        spawn: (_file, _args, { jobObject }) => {
          asked.push(jobObject);
          return child;
        },
        killTree: () => {},
        jobObjects,
      });
      return { asked, exec };
    };
    // What the helper writes when it could not start the program inside a job.
    const refusal = 'foedrum job object: PowerShell runs in ConstrainedLanguage mode\r\n';

    it('asks the spawner for a job only when the caller does', async () => {
      const child = new FakeChild();
      const { asked, exec } = jobSpawner(child);
      const held = exec('claude', [], { cwd: '/work/tree', jobObject: true });
      const plain = exec('git', [], { cwd: '/work/tree' });
      child.close(0);
      await Promise.all([held, plain]);
      assert.deepEqual(asked, [true, false]);
    });

    // Fail closed: a program that cannot be held in a job must not run outside one.
    it('answers without an exit code, with the reason, when the helper could not start it', async () => {
      const child = new FakeChild();
      const { exec } = jobSpawner(child);
      const done = exec('C:\\tools\\claude.exe', ['-p'], { cwd: 'D:\\work', jobObject: true });
      child.stdout.write(refusal);
      await settle();
      child.close(125);
      const reason =
        'C:\\tools\\claude.exe: cannot run in a Job Object: PowerShell runs in ConstrainedLanguage mode';
      assert.deepEqual(await done, { exitCode: null, stdout: '', stderr: reason, output: reason });
    });

    // The program's own exit code 125 and output stay its own.
    it('keeps the answer of a program that ran, whatever its exit code', async () => {
      const child = new FakeChild();
      const { exec } = jobSpawner(child);
      const done = exec('C:\\tools\\tool.exe', [], { cwd: 'D:\\work', jobObject: true });
      child.stdout.write('done\n');
      await settle();
      child.close(125);
      assert.deepEqual(await done, {
        exitCode: 125,
        stdout: 'done\n',
        stderr: '',
        output: 'done\n',
      });
    });

    it('keeps the answer when the program also wrote to stderr', async () => {
      const child = new FakeChild();
      const { exec } = jobSpawner(child);
      const done = exec('C:\\tools\\tool.exe', [], { cwd: 'D:\\work', jobObject: true });
      child.stdout.write(refusal);
      child.stderr.write('mine\n');
      await settle();
      child.close(125);
      assert.equal((await done).exitCode, 125);
    });

    // Windows PowerShell may start its stdout with a byte order mark (CLAUDE.md: parsers tolerate
    // a BOM).
    it('reads the refusal after a byte order mark', async () => {
      const child = new FakeChild();
      const { exec } = jobSpawner(child);
      const done = exec('C:\\tools\\claude.exe', [], { cwd: 'D:\\work', jobObject: true });
      child.stdout.write(`\uFEFF${refusal}`);
      await settle();
      child.close(125);
      const result = await done;
      assert.equal(result.exitCode, null);
      assert.equal(
        result.stderr,
        'C:\\tools\\claude.exe: cannot run in a Job Object: PowerShell runs in ConstrainedLanguage mode',
      );
    });

    // Only the helper's own exit code makes its line a refusal.
    it('keeps the answer of a program that wrote the refusal line itself and exited otherwise', async () => {
      for (const code of [0, 1]) {
        const child = new FakeChild();
        const { exec } = jobSpawner(child);
        const done = exec('C:\\tools\\tool.exe', [], { cwd: 'D:\\work', jobObject: true });
        child.stdout.write(refusal);
        await settle();
        child.close(code);
        assert.deepEqual(await done, {
          exitCode: code,
          stdout: refusal,
          stderr: '',
          output: refusal,
        });
      }
    });

    // Elsewhere, and without the option, no helper runs, so nothing it could say is looked for.
    it('reads nothing as the helper when no job was asked for or none is held', async () => {
      for (const [jobObjects, jobObject] of [
        [false, true],
        [true, false],
      ] as const) {
        const child = new FakeChild();
        const { exec } = jobSpawner(child, jobObjects);
        const done = exec('/usr/bin/tool', [], { cwd: '/work', jobObject });
        child.stdout.write(refusal);
        await settle();
        child.close(125);
        assert.equal((await done).exitCode, 125);
      }
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

// The brewer runner reads claude's stream-json as it comes: a long attempt writes far more than
// 4 MiB in total, but each line is one event (ADR 0046).
describe('streamProcessWith', () => {
  const streamer = (child: FakeChild | Error = new FakeChild(), jobObjects = false) => {
    const spawned: { file: string; args: string[]; stdin: boolean | undefined }[] = [];
    const killed: number[] = [];
    const spawner: Spawner = {
      spawn: (file, args, { stdin }) => {
        spawned.push({ file, args, stdin });
        if (child instanceof Error) throw child;
        return child;
      },
      killTree: (pid) => {
        killed.push(pid);
      },
      jobObjects,
    };
    const lines: string[] = [];
    const stream = streamProcessWith(spawner);
    const options = { cwd: '/work/tree', onLine: (line: string) => lines.push(line) };
    return { spawned, killed, lines, stream, options };
  };

  it('hands over each line of stdout as it comes, without its line ending', async () => {
    const child = new FakeChild();
    const { lines, stream, options } = streamer(child);
    const done = stream('claude', ['-p'], { ...options, maxLineBytes: 100 });
    child.stdout.write('{"type":"system"}\n{"type":');
    await settle();
    assert.deepEqual(lines, ['{"type":"system"}']);
    child.stdout.write('"assistant"}\r\n\n');
    await settle();
    assert.deepEqual(lines, ['{"type":"system"}', '{"type":"assistant"}', '']);
    child.stderr.write('warning');
    child.close(0);
    assert.deepEqual(await done, { exitCode: 0, stderr: 'warning' });
  });

  it('hands over a last line that has no line ending when the process closes', async () => {
    const child = new FakeChild();
    const { lines, stream, options } = streamer(child);
    const done = stream('claude', [], { ...options, maxLineBytes: 100 });
    child.stdout.write('one\ntwo');
    await settle();
    child.close(1);
    assert.deepEqual(await done, { exitCode: 1, stderr: '' });
    assert.deepEqual(lines, ['one', 'two']);
  });

  it('keeps a character whose bytes arrive in two chunks', async () => {
    const child = new FakeChild();
    const { lines, stream, options } = streamer(child);
    const done = stream('claude', [], { ...options, maxLineBytes: 100 });
    const bytes = Buffer.from('é\n');
    child.stdout.write(bytes.subarray(0, 1));
    child.stdout.write(bytes.subarray(1));
    await settle();
    child.close(0);
    await done;
    assert.deepEqual(lines, ['é']);
  });

  it('has no total limit: many lines may pass 4 MiB together', async () => {
    const child = new FakeChild();
    const { killed, stream } = streamer(child);
    let count = 0;
    const done = stream('claude', [], {
      cwd: '/work/tree',
      maxLineBytes: 64 * 1024,
      onLine: () => {
        count += 1;
      },
    });
    const line = `${'x'.repeat(32 * 1024 - 1)}\n`;
    for (let i = 0; i < 160; i += 1) child.stdout.write(line);
    await settle();
    child.close(0);
    assert.equal((await done).killed, undefined);
    assert.equal(count, 160);
    assert.deepEqual(killed, []);
  });

  it('writes its input to stdin and closes it, asking for a pipe only then', async () => {
    const child = new FakeChild();
    const { spawned, stream, options } = streamer(child);
    let input = '';
    child.stdin.setEncoding('utf8').on('data', (chunk: string) => {
      input += chunk;
    });
    const ended = new Promise((resolve) => child.stdin.on('finish', resolve));
    const done = stream('claude', ['-p'], { ...options, maxLineBytes: 100, stdin: 'prompt ✓' });
    await ended;
    child.close(0);
    await done;
    assert.equal(input, 'prompt ✓');
    const plain = new FakeChild();
    const second = streamer(plain);
    const without = second.stream('git', [], { ...second.options, maxLineBytes: 100 });
    plain.close(0);
    await without;
    assert.deepEqual([spawned[0]?.stdin, second.spawned[0]?.stdin], [true, false]);
  });

  // claude may exit before reading its stdin (a refused argument); the write then fails with
  // EPIPE, which must not crash the engine.
  it('answers from how the process ended when its stdin cannot be written', async () => {
    const child = new FakeChild();
    const { stream, options } = streamer(child);
    const done = stream('claude', [], { ...options, maxLineBytes: 100, stdin: 'prompt' });
    child.stdin.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }));
    child.stderr.write('error: unknown option');
    child.close(1);
    assert.deepEqual(await done, { exitCode: 1, stderr: 'error: unknown option' });
  });

  describe('with a line limit', () => {
    it('kills the whole tree when one line passes it, and hands over none of that line', async () => {
      const child = new FakeChild(81);
      const { killed, lines, stream, options } = streamer(child);
      const done = stream('claude', [], { ...options, maxLineBytes: 8 });
      child.stdout.write('12345678\n1234');
      await settle();
      assert.deepEqual(killed, []);
      child.stdout.write('5');
      await settle();
      child.stdout.write('6789\n');
      await settle();
      child.close(0);
      assert.deepEqual(await done, { exitCode: null, stderr: '', killed: 'line-too-long' });
      assert.deepEqual(killed, [81]);
      assert.deepEqual(lines, ['12345678']);
      assert.ok(child.stdout.destroyed && child.stderr.destroyed, 'stops reading its output');
    });

    it('counts bytes, not characters, and not the line ending', async () => {
      const child = new FakeChild();
      const { lines, stream, options } = streamer(child);
      const done = stream('claude', [], { ...options, maxLineBytes: 4 });
      child.stdout.write('éé\r\nééé\n');
      await settle();
      child.close(0);
      assert.equal((await done).killed, 'line-too-long');
      assert.deepEqual(lines, ['éé']);
    });

    // The process has closed, so there is no tree to kill: its pid may already belong to another.
    it('counts a last line without a line ending too, and kills nothing once it has closed', async () => {
      const child = new FakeChild(82);
      const { killed, stream, options } = streamer(child);
      const done = stream('claude', [], { ...options, maxLineBytes: 4 });
      child.stdout.write('12345');
      await settle();
      child.close(0);
      assert.equal((await done).killed, 'line-too-long');
      assert.deepEqual(killed, []);
    });
  });

  it('counts the bytes of stderr, not its characters', async () => {
    const child = new FakeChild();
    const { stream, options } = streamer(child);
    const done = stream('claude', [], { ...options, maxLineBytes: 100, maxStderrBytes: 4 });
    child.stderr.write('éé');
    await settle();
    child.stderr.write('é');
    await settle();
    child.close(0);
    assert.deepEqual(await done, { exitCode: null, stderr: 'éé', killed: 'too-much-output' });
  });

  it('kills the whole tree when stderr passes its limit, keeping what came within it', async () => {
    const child = new FakeChild(83);
    const { killed, stream, options } = streamer(child);
    const done = stream('claude', [], { ...options, maxLineBytes: 100, maxStderrBytes: 4 });
    child.stderr.write('abcd');
    await settle();
    assert.deepEqual(killed, []);
    child.stderr.write('e');
    await settle();
    child.close(0);
    assert.deepEqual(await done, { exitCode: null, stderr: 'abcd', killed: 'too-much-output' });
    assert.deepEqual(killed, [83]);
  });

  it('kills the whole tree at the deadline and answers at once, as timed out', async () => {
    const child = new FakeChild(84);
    const { killed, stream, options } = streamer(child);
    const result = await stream('claude', [], { ...options, maxLineBytes: 100, timeoutMs: 5 });
    assert.deepEqual(result, { exitCode: null, stderr: '', killed: 'timed-out' });
    assert.deepEqual(killed, [84]);
  });

  // The brewer runner stops the attempt from a line (a mismatched init, maxDenials): the lines
  // after it in the same chunk must not be handed over.
  it('hands over no further line once the signal aborts, and answers as stopped', async () => {
    const child = new FakeChild(85);
    const { killed, stream } = streamer(child);
    const stop = new AbortController();
    const lines: string[] = [];
    const done = stream('claude', [], {
      cwd: '/work/tree',
      maxLineBytes: 100,
      signal: stop.signal,
      onLine: (line) => {
        lines.push(line);
        if (line === 'stop') stop.abort();
      },
    });
    child.stdout.write('a\nstop\nb\n');
    await settle();
    assert.deepEqual(await done, { exitCode: null, stderr: '', killed: 'stopped' });
    assert.deepEqual(lines, ['a', 'stop']);
    assert.deepEqual(killed, [85]);
  });

  // The brewer runner relies on the job (ADR 0039): a stream must reach spawn as it was asked.
  it('starts the program with its arguments, directory, environment and Job Object', async () => {
    const child = new FakeChild();
    const asked: unknown[] = [];
    const stream = streamProcessWith({
      spawn: (file, args, options) => {
        asked.push({ file, args, ...options });
        return child;
      },
      killTree: () => {},
    });
    const done = stream('claude', ['-p'], {
      cwd: '/work/tree',
      env: { PATH: '/bin' },
      jobObject: true,
      maxLineBytes: 100,
      onLine: () => {},
    });
    child.close(0);
    await done;
    assert.deepEqual(asked, [
      {
        file: 'claude',
        args: ['-p'],
        cwd: '/work/tree',
        env: { PATH: '/bin' },
        jobObject: true,
        stdin: false,
      },
    ]);
  });

  it('sets the deadline on the given clock, kills only at it, and clears it once the process ended', async () => {
    const pending = new Map<number, () => void>();
    let next = 0;
    const timers: Timers = {
      set: (callback, ms) => {
        next += 1;
        pending.set(next, callback);
        assert.equal(ms, 60_000);
        return next;
      },
      clear: (timer) => {
        pending.delete(timer as number);
      },
    };
    const killed: number[] = [];
    const spawnerOf = (child: FakeChild): Spawner => ({
      spawn: () => child,
      killTree: (pid) => {
        killed.push(pid);
      },
    });
    const options = { cwd: '/work/tree', maxLineBytes: 100, timeoutMs: 60_000, onLine: () => {} };
    const ending = new FakeChild(86);
    const ended = streamProcessWith(spawnerOf(ending), timers)('claude', [], options);
    ending.close(0);
    await ended;
    assert.equal(pending.size, 0);
    const hanging = new FakeChild(87);
    const hung = streamProcessWith(spawnerOf(hanging), timers)('claude', [], options);
    assert.deepEqual(killed, []);
    for (const fire of pending.values()) fire();
    assert.deepEqual(await hung, { exitCode: null, stderr: '', killed: 'timed-out' });
    assert.deepEqual(killed, [87]);
  });

  it('kills a line without end while it is still being written, not only when the process closes', async () => {
    const child = new FakeChild(88);
    const { killed, stream, options } = streamer(child);
    const done = stream('claude', [], { ...options, maxLineBytes: 4 });
    child.stdout.write('123456');
    await settle();
    assert.deepEqual(killed, [88]);
    assert.equal((await done).killed, 'line-too-long');
  });

  // The CR of a CRLF may arrive in one chunk and its LF in the next.
  it('lets a line of exactly the limit through when its CR and LF arrive apart', async () => {
    const child = new FakeChild();
    const { killed, lines, stream, options } = streamer(child);
    const done = stream('claude', [], { ...options, maxLineBytes: 4 });
    child.stdout.write('abcd\r');
    await settle();
    child.stdout.write('\n');
    await settle();
    child.close(0);
    assert.deepEqual(await done, { exitCode: 0, stderr: '' });
    assert.deepEqual(lines, ['abcd']);
    assert.deepEqual(killed, []);
  });

  // A killed process still closes, with a line it had only begun; the caller already has its
  // answer and must not get a cut-off line after it.
  // The caller parses untrusted lines; a throw must not leave the tree running and the answer
  // unsettled, nor reach the engine as an uncaught exception.
  it('kills the whole tree and answers with the error when the caller throws on a line', async () => {
    const child = new FakeChild(90);
    const { killed, stream } = streamer(child);
    const lines: string[] = [];
    const done = stream('claude', [], {
      cwd: '/work/tree',
      maxLineBytes: 100,
      onLine: (line) => {
        lines.push(line);
        if (line === 'b') throw new Error('cannot read the line');
      },
    });
    child.stderr.write('warning\n');
    await settle();
    // Emitted here, so an error the runner let through lands in this test, not elsewhere.
    let escaped: unknown;
    try {
      child.stdout.emit('data', 'a\nb\nc\n');
    } catch (error) {
      escaped = error;
    }
    assert.equal(escaped, undefined, 'the error escaped the runner');
    child.close(null);
    assert.deepEqual(await done, { exitCode: null, stderr: 'warning\ncannot read the line' });
    assert.deepEqual(lines, ['a', 'b']);
    assert.deepEqual(killed, [90]);
  });

  it('hands over no half-written line when the process closes after it was stopped', async () => {
    const child = new FakeChild();
    const { lines, stream, options } = streamer(child);
    const stop = new AbortController();
    const done = stream('claude', [], { ...options, maxLineBytes: 100, signal: stop.signal });
    child.stdout.write('{"type":"assis');
    await settle();
    stop.abort();
    child.close(null);
    assert.equal((await done).killed, 'stopped');
    assert.deepEqual(lines, []);
  });

  it('starts nothing when the signal has already aborted', async () => {
    const { spawned, stream, options } = streamer();
    const result = await stream('claude', [], {
      ...options,
      maxLineBytes: 100,
      signal: AbortSignal.abort(),
    });
    assert.deepEqual(spawned, []);
    assert.deepEqual(result, { exitCode: null, stderr: '', killed: 'stopped' });
  });

  it('answers without an exit code, with the reason, when the program cannot start', async () => {
    const { stream, options } = streamer(new Error('spawn claude ENOENT'));
    const result = await stream('claude', [], { ...options, maxLineBytes: 100 });
    assert.deepEqual(result, { exitCode: null, stderr: 'spawn claude ENOENT' });
  });

  it('starts the file the spawner resolves the name to, and nothing when there is none', async () => {
    const child = new FakeChild();
    const started: string[] = [];
    const spawner: Spawner = {
      spawn: (file) => {
        started.push(file);
        return child;
      },
      killTree: () => {},
      resolve: (file) => (file === 'claude' ? 'C:\\tools\\claude.exe' : undefined),
    };
    const stream = streamProcessWith(spawner);
    const options = { cwd: '/work/tree', maxLineBytes: 100, onLine: () => {} };
    const done = stream('claude', [], options);
    child.close(0);
    assert.deepEqual(await done, { exitCode: 0, stderr: '' });
    assert.deepEqual(await stream('nope', [], options), {
      exitCode: null,
      stderr: 'nope: not found on PATH (ENOENT)',
    });
    assert.deepEqual(started, ['C:\\tools\\claude.exe']);
  });

  // A crash or the OOM killer on macOS and Linux: the runner did not send it, so it is no kill.
  it('answers with the signal that ended the process, when the runner did not end it', async () => {
    const child = new FakeChild();
    const { stream, options } = streamer(child);
    const done = stream('claude', [], { ...options, maxLineBytes: 100 });
    child.close(null, 'SIGKILL');
    assert.deepEqual(await done, { exitCode: null, stderr: '', signal: 'SIGKILL' });
  });

  it('answers without an exit code, with the reason, when the process fails', async () => {
    const child = new FakeChild();
    const { stream, options } = streamer(child);
    const done = stream('claude', [], { ...options, maxLineBytes: 100 });
    child.stderr.write('partial\n');
    await settle();
    child.emit('error', new Error('read EPIPE'));
    assert.deepEqual(await done, { exitCode: null, stderr: 'partial\nread EPIPE' });
  });

  // A program that runs without its prompt would answer something else (#128).
  it('answers as not started, and ends the tree, when stdin was given but has no pipe', async () => {
    const child = new FakeChild(77);
    Object.assign(child, { stdin: null });
    const { killed, lines, stream, options } = streamer(child);
    const done = stream('claude', [], { ...options, maxLineBytes: 100, stdin: 'prompt' });
    child.stdout.write('{"type":"system"}\n');
    await settle();
    child.close(0);
    const result = await done;
    assert.equal(result.exitCode, null);
    assert.equal(result.killed, undefined);
    assert.match(result.stderr, /^claude: no pipe to its stdin/);
    assert.deepEqual(killed, [77]);
    assert.deepEqual(lines, []);
  });

  describe('in a Job Object', () => {
    const refusal = 'foedrum job object: PowerShell runs in ConstrainedLanguage mode\r\n';

    // Between the direct child's exit and the close of its pipes, a kill would use an exited pid,
    // which taskkill /T cannot follow to the grandchildren (#128).
    it('starts nothing where the spawner holds jobs and none was asked for', async () => {
      const child = new FakeChild();
      const { spawned, stream, options } = streamer(child, true);
      const done = stream('claude', [], { ...options, maxLineBytes: 1000 });
      await settle();
      child.close(0);
      const result = await done;
      assert.deepEqual(spawned, []);
      assert.equal(result.exitCode, null);
      assert.equal(result.killed, undefined);
      assert.match(result.stderr, /^claude: streamProcess runs a program only in a Job Object/);
    });

    // Fail closed (ADR 0039): the helper's refusal is not a line of the program's.
    it('answers as not started, and hands over no line, when the helper could not start it', async () => {
      const child = new FakeChild();
      const { lines, stream, options } = streamer(child, true);
      const done = stream('C:\\tools\\claude.exe', [], {
        ...options,
        maxLineBytes: 1000,
        jobObject: true,
      });
      child.stdout.write(`\uFEFF${refusal}`);
      await settle();
      child.close(125);
      assert.deepEqual(await done, {
        exitCode: null,
        stderr:
          'C:\\tools\\claude.exe: cannot run in a Job Object: PowerShell runs in ConstrainedLanguage mode',
      });
      assert.deepEqual(lines, []);
    });

    it("hands over a program's own first line that looks like the refusal once it ends otherwise", async () => {
      const child = new FakeChild();
      const { lines, stream, options } = streamer(child, true);
      const done = stream('claude', [], { ...options, maxLineBytes: 1000, jobObject: true });
      child.stdout.write(`${refusal}next\n`);
      await settle();
      child.close(0);
      assert.deepEqual(await done, { exitCode: 0, stderr: '' });
      assert.deepEqual(lines, [refusal.trimEnd(), 'next']);
    });

    it("hands over a program's only line that looks like the refusal when it ends otherwise", async () => {
      const child = new FakeChild();
      const { lines, stream, options } = streamer(child, true);
      const done = stream('claude', [], { ...options, maxLineBytes: 1000, jobObject: true });
      child.stdout.write(refusal);
      await settle();
      assert.deepEqual(lines, []);
      child.close(0);
      assert.deepEqual(await done, { exitCode: 0, stderr: '' });
      assert.deepEqual(lines, [refusal.trimEnd()]);
    });

    // Outside Windows no helper exists to refuse anything (ADR 0039).
    it('hands over the first line at once when the spawner holds no job', async () => {
      const child = new FakeChild();
      const { lines, stream, options } = streamer(child, false);
      const done = stream('claude', [], { ...options, maxLineBytes: 1000, jobObject: true });
      child.stdout.write(refusal);
      await settle();
      assert.deepEqual(lines, [refusal.trimEnd()]);
      child.close(125);
      assert.deepEqual(await done, { exitCode: 125, stderr: '' });
    });

    it('hands over nothing after a held first line from which the caller stopped', async () => {
      const child = new FakeChild(89);
      const { killed, stream } = streamer(child, true);
      const stop = new AbortController();
      const lines: string[] = [];
      const done = stream('claude', [], {
        cwd: '/work/tree',
        maxLineBytes: 1000,
        jobObject: true,
        signal: stop.signal,
        onLine: (line) => {
          lines.push(line);
          stop.abort();
        },
      });
      child.stdout.write(`${refusal}next\n`);
      await settle();
      assert.deepEqual(await done, { exitCode: null, stderr: '', killed: 'stopped' });
      assert.deepEqual(lines, [refusal.trimEnd()]);
      assert.deepEqual(killed, [89]);
    });
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

describe('shellCommand', () => {
  const env = { PATH: 'C:\\nodejs', SystemRoot: 'D:\\WINDOWS' };

  it('runs a command line through /bin/sh outside Windows', () => {
    for (const platform of ['linux', 'darwin'] as const) {
      assert.deepEqual(shellCommand('npm test -- --reporter tap', platform, env), {
        file: 'npm test -- --reporter tap',
        args: [],
        shell: '/bin/sh',
        env,
      });
    }
  });

  it('runs a command line through cmd.exe by its full path on Windows, never from the working directory', () => {
    assert.deepEqual(shellCommand('gradlew.bat test', 'win32', env), {
      file: 'gradlew.bat test',
      args: [],
      shell: 'D:\\WINDOWS\\System32\\cmd.exe',
      env: { ...env, NoDefaultCurrentDirectoryInExePath: '1' },
    });
    assert.equal(
      shellCommand('npm test', 'win32', { PATH: 'C:\\nodejs' }).shell,
      'C:\\Windows\\System32\\cmd.exe',
    );
  });

  it('refuses a line break, which would end the command early', () => {
    assert.throws(() => shellCommand('npm test\nrm -rf /', 'linux', env), /one line/);
    assert.throws(() => shellCommand('npm test\r\ncalc', 'win32', env), /one line/);
  });
});
