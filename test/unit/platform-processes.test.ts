import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isPidAlive, type Kill, killProcessTree } from '../../src/platform/processes.ts';

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
