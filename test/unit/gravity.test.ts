import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  commandLine,
  type PlannedCheck,
  passed,
  planChecks,
  type RepositoryChecks,
  readingOf,
  settleReadings,
  tailOf,
} from '../../src/checks/gravity.ts';
import { GravityReading, MAX_TAIL_LENGTH } from '../../src/schemas/events.ts';

const repository: RepositoryChecks = {
  build: null,
  typecheck: 'npm run typecheck',
  lint: { run: 'npm run lint', windows: 'npm.cmd run lint' },
  format: null,
  test: 'npm test',
};

describe('commandLine', () => {
  const e2e = { run: 'make e2e', windows: 'nmake e2e', macos: 'gmake e2e', linux: 'make -j e2e' };

  it('takes a plain command as it is on every platform', () => {
    for (const platform of ['win32', 'darwin', 'linux', 'freebsd'] as const) {
      assert.equal(commandLine('npm test', platform), 'npm test');
    }
  });

  it("takes a command's override for the platform, else its run", () => {
    assert.equal(commandLine(e2e, 'win32'), 'nmake e2e');
    assert.equal(commandLine(e2e, 'darwin'), 'gmake e2e');
    assert.equal(commandLine(e2e, 'linux'), 'make -j e2e');
    assert.equal(commandLine(e2e, 'freebsd'), 'make e2e');
    assert.equal(commandLine({ run: 'make e2e' }, 'win32'), 'make e2e');
  });
});

describe('planChecks', () => {
  it("runs each named check through the repository's command, in the step's order", () => {
    assert.deepEqual(planChecks(['test', 'lint', 'typecheck'], repository, 'win32'), [
      { kind: 'run', check: 'test', command: 'npm test' },
      { kind: 'run', check: 'lint', command: 'npm.cmd run lint' },
      { kind: 'run', check: 'typecheck', command: 'npm run typecheck' },
    ]);
  });

  it('skips a check the repository has none of, never guessing a command (ADR 0023)', () => {
    assert.deepEqual(planChecks(['build', 'test'], repository, 'linux'), [
      { kind: 'skip', check: 'build' },
      { kind: 'run', check: 'test', command: 'npm test' },
    ]);
  });

  it("runs a Brewery's literal command without a check name", () => {
    assert.deepEqual(planChecks([{ run: 'make e2e', linux: 'make -j e2e' }], repository, 'linux'), [
      { kind: 'run', command: 'make -j e2e' },
    ]);
  });
});

describe('tailOf', () => {
  it('keeps output that fits as it is', () => {
    assert.equal(tailOf(''), '');
    assert.equal(tailOf('ok 1\nok 2\n'), 'ok 1\nok 2\n');
    const fits = 'x'.repeat(MAX_TAIL_LENGTH);
    assert.equal(tailOf(fits), fits);
  });

  it('keeps the end of longer output, where the failures show', () => {
    const output = `${'a'.repeat(10_000)}${'b'.repeat(MAX_TAIL_LENGTH - 10)}not ok 1\n!`;
    const tail = tailOf(output);
    assert.equal(tail.length, MAX_TAIL_LENGTH);
    assert.ok(output.endsWith(tail));
    assert.ok(tail.endsWith('not ok 1\n!'));
  });

  it('never starts with half a character', () => {
    // '🍺' is two UTF-16 units: the cut would fall between them.
    const output = `🍺${'x'.repeat(MAX_TAIL_LENGTH - 1)}`;
    const tail = tailOf(output);
    assert.equal(tail, 'x'.repeat(MAX_TAIL_LENGTH - 1));
    assert.ok(GravityReading.safeParse({ result: 'unstarted', command: 'a', tail }).success);
  });
});

describe('readingOf', () => {
  const test: Extract<PlannedCheck, { kind: 'run' }> = {
    kind: 'run',
    check: 'test',
    command: 'npm test',
  };

  it('reads the exit code and the tail of the output', () => {
    assert.deepEqual(readingOf(test, { exitCode: 1, output: `${'x'.repeat(5000)}not ok 1` }), {
      result: 'exited',
      check: 'test',
      command: 'npm test',
      exitCode: 1,
      tail: `${'x'.repeat(MAX_TAIL_LENGTH - 8)}not ok 1`,
    });
  });

  it('reads a literal command without a check name', () => {
    const e2e = { kind: 'run', command: 'make e2e' } as const;
    assert.deepEqual(readingOf(e2e, { exitCode: 0, output: '' }), {
      result: 'exited',
      command: 'make e2e',
      exitCode: 0,
      tail: '',
    });
  });

  it('reads why the runner killed the tree', () => {
    for (const killed of ['timed-out', 'stopped', 'too-much-output'] as const) {
      assert.deepEqual(readingOf(test, { exitCode: null, output: 'ok 1\n', killed }), {
        result: 'killed',
        check: 'test',
        command: 'npm test',
        killed,
        tail: 'ok 1\n',
      });
    }
  });

  it('reads a command that could not start, with the reason in the tail', () => {
    assert.deepEqual(readingOf(test, { exitCode: null, output: 'spawn /bin/sh ENOENT' }), {
      result: 'unstarted',
      check: 'test',
      command: 'npm test',
      tail: 'spawn /bin/sh ENOENT',
    });
  });
});

describe('passed', () => {
  it('lets a skip and a clean exit pass, and nothing else', () => {
    const ran = { check: 'test', command: 'npm test', tail: '' } as const;
    assert.equal(passed({ result: 'skipped', check: 'lint' }), true);
    assert.equal(passed({ result: 'exited', ...ran, exitCode: 0 }), true);
    assert.equal(passed({ result: 'exited', ...ran, exitCode: 1 }), false);
    assert.equal(passed({ result: 'exited', ...ran, exitCode: -1 }), false);
    assert.equal(passed({ result: 'killed', ...ran, killed: 'timed-out' }), false);
    assert.equal(passed({ result: 'unstarted', ...ran }), false);
  });
});

describe('settleReadings', () => {
  const ran = { check: 'test', command: 'npm test', tail: 'not ok 1\n' } as const;
  const lintPassed = {
    result: 'exited',
    check: 'lint',
    command: 'npm run lint',
    exitCode: 0,
    tail: '',
  } as const;

  it('succeeds when every check passed or was skipped', () => {
    assert.deepEqual(settleReadings([{ result: 'skipped', check: 'build' }, lintPassed]), {
      kind: 'succeeded',
      output: null,
    });
  });

  it('fails without a retry when a check failed: the same tree would fail again', () => {
    assert.deepEqual(settleReadings([lintPassed, { result: 'exited', ...ran, exitCode: 2 }]), {
      kind: 'failed',
      retryable: false,
      reason: 'the check "test" (npm test) failed with exit code 2',
    });
    const e2e = { result: 'exited', command: 'make e2e', exitCode: 1, tail: '' } as const;
    assert.deepEqual(settleReadings([e2e]), {
      kind: 'failed',
      retryable: false,
      reason: 'the check "make e2e" failed with exit code 1',
    });
  });

  it("fails without a retry when a check ran past the step's deadline", () => {
    assert.deepEqual(settleReadings([{ result: 'killed', ...ran, killed: 'timed-out' }]), {
      kind: 'failed',
      retryable: false,
      reason: 'the check "test" (npm test) did not finish by the step\'s deadline',
    });
  });

  it('is cancelled when the engine stopped it', () => {
    assert.deepEqual(settleReadings([{ result: 'killed', ...ran, killed: 'stopped' }]), {
      kind: 'cancelled',
    });
  });

  it('is blocked by its environment when a check wrote too much or could not start', () => {
    assert.deepEqual(settleReadings([{ result: 'killed', ...ran, killed: 'too-much-output' }]), {
      kind: 'blocked',
      blockerKind: 'environment',
      summary: 'the check "test" (npm test) wrote more output than the process runner\'s limit',
    });
    const unstarted = { result: 'unstarted', ...ran, tail: 'cmd.exe\nspawn ENOENT\n\n' } as const;
    assert.deepEqual(settleReadings([unstarted]), {
      kind: 'blocked',
      blockerKind: 'environment',
      summary: 'the check "test" (npm test) could not start: spawn ENOENT',
    });
    assert.deepEqual(settleReadings([{ ...unstarted, tail: '' }]), {
      kind: 'blocked',
      blockerKind: 'environment',
      summary: 'the check "test" (npm test) could not start',
    });
  });
});
