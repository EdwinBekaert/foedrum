// Keeping the machine awake while an attempt runs (#476, ADR 0195), with a fake PATH and a fake
// process runner: which helper each platform starts, and when it starts and stops. No process
// starts (ADR 0021).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  type AwakeCommand,
  awakeCommand,
  awakeMechanism,
  keepAwake,
} from '../../src/platform/keep-awake.ts';
import type { ExecOptions, ExecProcess, ExecResult } from '../../src/platform/processes.ts';
import { cuedTimers } from '../helpers/load.ts';

const onPath =
  (found: Record<string, string>) =>
  (name: string): string | undefined =>
    found[name];

describe('awakeMechanism', () => {
  it("is SetThreadExecutionState through Windows PowerShell in SystemRoot's System32 on Windows", () => {
    assert.deepStrictEqual(
      awakeMechanism({
        platform: 'win32',
        resolve: onPath({}),
        env: { SystemRoot: 'D:\\Win' },
        exists: () => false,
      }),
      {
        kind: 'SetThreadExecutionState',
        program: 'D:\\Win\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
      },
    );
  });

  it('is caffeinate on macOS, found on PATH', () => {
    assert.deepStrictEqual(
      awakeMechanism({
        platform: 'darwin',
        resolve: onPath({ caffeinate: '/usr/bin/caffeinate' }),
        env: {},
        exists: () => false,
      }),
      { kind: 'caffeinate', program: '/usr/bin/caffeinate' },
    );
  });

  it('is systemd-inhibit with tail on Linux, both found on PATH', () => {
    assert.deepStrictEqual(
      awakeMechanism({
        platform: 'linux',
        resolve: onPath({ 'systemd-inhibit': '/usr/bin/systemd-inhibit', tail: '/usr/bin/tail' }),
        env: {},
        exists: (path) => path === '/run/systemd/system',
      }),
      { kind: 'systemd-inhibit', program: '/usr/bin/systemd-inhibit', tail: '/usr/bin/tail' },
    );
  });

  it('is none, saying why, where the program is missing or the platform has no way', () => {
    const none = (platform: NodeJS.Platform, found: Record<string, string>) =>
      awakeMechanism({ platform, resolve: onPath(found), env: {}, exists: () => true });
    assert.deepStrictEqual(none('linux', { tail: '/usr/bin/tail' }), {
      kind: 'none',
      why: 'no systemd-inhibit on PATH',
    });
    assert.deepStrictEqual(none('linux', { 'systemd-inhibit': '/usr/bin/systemd-inhibit' }), {
      kind: 'none',
      why: 'no tail on PATH',
    });
    assert.deepStrictEqual(none('darwin', {}), { kind: 'none', why: 'no caffeinate on PATH' });
    assert.deepStrictEqual(none('freebsd', { caffeinate: '/usr/bin/caffeinate' }), {
      kind: 'none',
      why: 'Foedrum knows no way on freebsd',
    });
  });
});

describe('awakeCommand', () => {
  it('runs caffeinate on idle sleep until the process ends', () => {
    assert.deepStrictEqual(
      awakeCommand({ kind: 'caffeinate', program: '/usr/bin/caffeinate' }, 4242),
      { file: '/usr/bin/caffeinate', args: ['-i', '-w', '4242'] },
    );
  });

  it("holds logind's idle and sleep lock while tail waits on the process", () => {
    assert.deepStrictEqual(
      awakeCommand(
        { kind: 'systemd-inhibit', program: '/usr/bin/systemd-inhibit', tail: '/usr/bin/tail' },
        4242,
      ),
      {
        file: '/usr/bin/systemd-inhibit',
        args: [
          '--what=idle:sleep',
          '--who=foedrum',
          '--why=foedrum brewing',
          '--mode=block',
          '/usr/bin/tail',
          '--pid=4242',
          '-f',
          '/dev/null',
        ],
      },
    );
  });

  it('runs PowerShell with an encoded command that holds the system awake and waits on the process', () => {
    const program = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
    const command = awakeCommand({ kind: 'SetThreadExecutionState', program }, 4242);
    assert.equal(command?.file, program);
    assert.deepStrictEqual(command?.args.slice(0, -1), [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-EncodedCommand',
    ]);
    const script = Buffer.from(command?.args.at(-1) ?? '', 'base64').toString('utf16le');
    // ES_CONTINUOUS | ES_SYSTEM_REQUIRED, never ES_DISPLAY_REQUIRED: the display may turn off.
    assert.match(script, /SetThreadExecutionState/);
    assert.match(script, /0x80000001/);
    assert.match(script, /GetProcessById\(4242\)\.WaitForExit\(\)/);
    // No cmdlet loads a module, and nothing is compiled into the temp folder (ADR 0039, #177).
    assert.match(script, /\$PSModuleAutoLoadingPreference = 'None'/);
    assert.doesNotMatch(script, /Add-Type/);
  });

  it('passes ES_CONTINUOUS | ES_SYSTEM_REQUIRED to the call itself, and ends the helper when it is refused', () => {
    const program = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
    const command = awakeCommand({ kind: 'SetThreadExecutionState', program }, 4242);
    const script = Buffer.from(command?.args.at(-1) ?? '', 'base64').toString('utf16le');
    // 0x80000001 in decimal: ES_DISPLAY_REQUIRED (0x2) would make it 2147483651.
    assert.match(
      script,
      /^if \(\$k::SetThreadExecutionState\(\[uint32\]2147483649\) -eq 0\) \{ exit 1 \}$/m,
    );
  });

  it('starts nothing without a mechanism', () => {
    assert.equal(awakeCommand({ kind: 'none', why: 'no caffeinate on PATH' }, 4242), undefined);
  });

  it('refuses a process id that is not one', () => {
    const caffeinate = { kind: 'caffeinate', program: '/usr/bin/caffeinate' } as const;
    for (const pid of [0, -1, 1.5, Number.NaN]) {
      assert.throws(() => awakeCommand(caffeinate, pid), /not a process id/);
    }
  });
});

describe('awakeMechanism without SystemRoot', () => {
  it('takes Windows PowerShell from C:\\Windows when the environment names no SystemRoot', () => {
    assert.deepStrictEqual(
      awakeMechanism({ platform: 'win32', resolve: onPath({}), env: {}, exists: () => false }),
      {
        kind: 'SetThreadExecutionState',
        program: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
      },
    );
  });
});

describe('keepAwake', () => {
  const helper: AwakeCommand = { file: '/usr/bin/caffeinate', args: ['-i', '-w', '4242'] };
  /** A process runner whose helpers run until stopped, or until `end` ends one on its own. */
  const fakeExec = () => {
    const started: { file: string; args: readonly string[]; options: ExecOptions }[] = [];
    const ends: ((result: ExecResult) => void)[] = [];
    const endedAlone = new Set<number>();
    const exec: ExecProcess = (file, args, options) =>
      new Promise((done) => {
        started.push({ file, args, options });
        ends.push(done);
        options.signal?.addEventListener('abort', () =>
          done({ exitCode: null, stdout: '', stderr: '', output: '', killed: 'stopped' }),
        );
      });
    // Neither stopped nor ended on its own.
    const live = () =>
      started.filter(
        ({ options }, index) => options.signal?.aborted !== true && !endedAlone.has(index),
      ).length;
    const end = async (index: number) => {
      endedAlone.add(index);
      ends[index]?.({ exitCode: 1, stdout: '', stderr: '', output: '' });
      await new Promise((settle) => setImmediate(settle));
    };
    return { exec, started, live, end };
  };

  it('starts nothing until an attempt starts', () => {
    const { exec, started } = fakeExec();
    keepAwake({ command: helper, exec, cwd: '/home/ann' });
    assert.deepStrictEqual(started, []);
  });

  it('starts the helper when the first attempt starts, with no deadline, and stops it when none runs', () => {
    const { exec, started, live } = fakeExec();
    const timers = cuedTimers();
    const hold = keepAwake({ command: helper, exec, cwd: '/home/ann', timers });
    hold.attemptStarted();
    assert.equal(started.length, 1);
    assert.equal(started[0]?.file, '/usr/bin/caffeinate');
    assert.deepStrictEqual(started[0]?.args, ['-i', '-w', '4242']);
    assert.equal(started[0]?.options.cwd, '/home/ann');
    assert.equal(started[0]?.options.timeoutMs, undefined);
    // A second attempt alongside shares the hold; it lasts until the last one ends.
    hold.attemptStarted();
    hold.attemptEnded();
    assert.deepStrictEqual([started.length, live()], [1, 1]);
    hold.attemptEnded();
    timers.fire();
    assert.equal(live(), 0);
  });

  it('starts the helper again when an attempt starts after none ran', () => {
    const { exec, started, live } = fakeExec();
    const timers = cuedTimers();
    const hold = keepAwake({ command: helper, exec, cwd: '/home/ann', timers });
    hold.attemptStarted();
    hold.attemptEnded();
    timers.fire();
    hold.attemptStarted();
    assert.deepStrictEqual([started.length, live()], [2, 1]);
  });

  it('keeps the helper it started again when the one it stopped reports its end late', async () => {
    const { exec, started, live } = fakeExec();
    const timers = cuedTimers();
    const hold = keepAwake({ command: helper, exec, cwd: '/home/ann', timers });
    hold.attemptStarted();
    hold.attemptEnded();
    timers.fire();
    hold.attemptStarted();
    // The first helper's end arrives now, after the second one started.
    await new Promise((settle) => setImmediate(settle));
    hold.attemptStarted();
    assert.equal(started.length, 2);
    hold.attemptEnded();
    hold.attemptEnded();
    timers.fire();
    assert.equal(live(), 0);
  });

  it('starts the helper again at the next attempt when it ended on its own', async () => {
    const { exec, started, live, end } = fakeExec();
    const hold = keepAwake({ command: helper, exec, cwd: '/home/ann' });
    hold.attemptStarted();
    await end(0);
    hold.attemptStarted();
    assert.deepStrictEqual([started.length, live()], [2, 1]);
  });

  it('lets the hold go when the command ends, and starts nothing after', () => {
    const { exec, started, live } = fakeExec();
    const hold = keepAwake({ command: helper, exec, cwd: '/home/ann' });
    hold.attemptStarted();
    hold.release();
    assert.equal(live(), 0);
    hold.attemptStarted();
    assert.equal(started.length, 1);
  });

  it('starts nothing without a helper', () => {
    const { exec, started } = fakeExec();
    const hold = keepAwake({ command: undefined, exec, cwd: '/home/ann' });
    hold.attemptStarted();
    hold.attemptEnded();
    hold.release();
    assert.deepStrictEqual(started, []);
  });
});

describe('keepAwake: the minute after the last attempt (ADR 0195)', () => {
  const helper: AwakeCommand = { file: '/usr/bin/caffeinate', args: ['-i', '-w', '4242'] };
  const running = () => {
    const started: AbortSignal[] = [];
    const exec: ExecProcess = (_file, _args, options) => {
      if (options.signal !== undefined) started.push(options.signal);
      return new Promise(() => {});
    };
    const live = () => started.filter((signal) => !signal.aborted).length;
    return { exec, started, live };
  };

  it('keeps holding until the minute after the last attempt has passed, then lets go', () => {
    const { exec, live } = running();
    const timers = cuedTimers();
    const hold = keepAwake({ command: helper, exec, cwd: '/home/ann', timers });
    hold.attemptStarted();
    hold.attemptEnded();
    assert.equal(live(), 1);
    timers.fire();
    assert.equal(live(), 0);
  });

  it('keeps the same helper for an attempt that starts within that minute, the next step of a batch', () => {
    const { exec, started, live } = running();
    const timers = cuedTimers();
    const hold = keepAwake({ command: helper, exec, cwd: '/home/ann', timers });
    hold.attemptStarted();
    hold.attemptEnded();
    hold.attemptStarted();
    assert.deepStrictEqual([started.length, live()], [1, 1]);
    // The minute it waited is called off: only the end of the new attempt starts another.
    assert.throws(() => timers.fire(), /no timer to fire/);
  });
});

describe('awakeMechanism: systemd that is not running', () => {
  it('is none on Linux when /run/systemd/system is not there, though both programs are on PATH', () => {
    const asked: string[] = [];
    assert.deepStrictEqual(
      awakeMechanism({
        platform: 'linux',
        resolve: onPath({ 'systemd-inhibit': '/usr/bin/systemd-inhibit', tail: '/usr/bin/tail' }),
        env: {},
        exists: (path) => {
          asked.push(path);
          return false;
        },
      }),
      { kind: 'none', why: 'systemd is not running' },
    );
    assert.deepStrictEqual(asked, ['/run/systemd/system']);
  });
});
