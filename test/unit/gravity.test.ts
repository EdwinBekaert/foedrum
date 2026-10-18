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

  it('never starts with half a character at either end of the low surrogates', () => {
    // U+10000 ends in 0xDC00, U+10FFFF in 0xDFFF: the first and last second halves of a pair.
    for (const character of ['\u{10000}', '\u{10FFFF}']) {
      const tail = tailOf(`${character}${'x'.repeat(MAX_TAIL_LENGTH - 1)}`);
      assert.equal(tail, 'x'.repeat(MAX_TAIL_LENGTH - 1), character.codePointAt(0)?.toString(16));
    }
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

  it('reads a check that a signal ended as such, not as one that could not start', () => {
    const run = { exitCode: null, output: 'ok 1\nSegmentation fault\n', signal: 'SIGSEGV' };
    assert.deepEqual(readingOf(test, run), {
      result: 'signaled',
      check: 'test',
      command: 'npm test',
      signal: 'SIGSEGV',
      tail: 'ok 1\nSegmentation fault\n',
    });
  });

  it('reads a command that could not start, with the reason in the tail', () => {
    assert.deepEqual(readingOf(test, { exitCode: null, output: 'spawn /bin/sh ENOENT' }), {
      result: 'unstarted',
      check: 'test',
      command: 'npm test',
      tail: 'spawn /bin/sh ENOENT',
    });
  });

  // The output is untrusted: a check runs code a brewer may have written (ADR 0069).
  it('leaves out each line of the output that looks like a secret, saying what it looked like', () => {
    const token = `ghp_${'A1b2'.repeat(9)}`;
    const output = [
      'ok 1 - reads the config',
      `GH_TOKEN=${token}`,
      'key AKIAABCDEFGHIJKLMNOP in the fixture',
      'not ok 2 - password: hunter2',
      'ok 3',
      '',
    ].join('\n');
    const reading = readingOf(test, { exitCode: 1, output });
    assert.equal(
      reading.result === 'exited' && reading.tail,
      [
        'ok 1 - reads the config',
        '[left out: a line that looks like a secret (GitHub token)]',
        '[left out: a line that looks like a secret (AWS access key id)]',
        '[left out: a line that looks like a secret (credential assignment)]',
        'ok 3',
        '',
      ].join('\n'),
    );
    for (const secret of [token, 'AKIAABCDEFGHIJKLMNOP', 'hunter2']) {
      assert.ok(!JSON.stringify(reading).includes(secret), secret);
    }
  });

  it('leaves out a 40-character hash too: the engine cannot tell a commit from a key', () => {
    const output = `ok 1\nHEAD is ${'0123456789abcdef'.repeat(2)}01234567\nok 2\n`;
    const reading = readingOf(test, { exitCode: 0, output });
    assert.equal(
      reading.result === 'exited' && reading.tail,
      'ok 1\n[left out: a line that looks like a secret (long hexadecimal string)]\nok 2\n',
    );
  });

  // A brewer may write a test that prints this; the Cellar's event loop must not stall on it.
  it('reads output that matches the secret patterns thousands of times on one line at once', () => {
    const output = 'token=a '.repeat(40_000);
    const started = performance.now();
    const reading = readingOf(test, { exitCode: 1, output });
    const took = performance.now() - started;
    assert.ok(took < 1_000, `took ${Math.round(took)} ms`);
    assert.ok(reading.result === 'exited');
    assert.equal(
      reading.tail,
      '[left out: a line that looks like a secret (credential assignment)]',
    );
  });

  it('leaves a secret out before it bounds the tail, so no part of it is kept', () => {
    const token = `ghp_${'A1b2'.repeat(9)}`;
    const output = `${token}\n${'x'.repeat(MAX_TAIL_LENGTH - 20)}`;
    const reading = readingOf(test, { exitCode: null, output });
    assert.ok(reading.result === 'unstarted');
    assert.ok(!reading.tail.includes(token.slice(-12)), reading.tail.slice(0, 60));
    assert.ok(reading.tail.length <= MAX_TAIL_LENGTH);
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

  it('fails without a retry when a signal ended a check that ran: it goes along onFail', () => {
    const signaled = { result: 'signaled', ...ran, signal: 'SIGABRT' } as const;
    assert.equal(passed(signaled), false);
    assert.deepEqual(settleReadings([signaled]), {
      kind: 'failed',
      retryable: false,
      reason: 'the check "test" (npm test) was ended by SIGABRT',
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
