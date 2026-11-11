// The checks before a brewer's end, the core (ADR 0381): which of the repository's checks run, on
// which paths, and the message that sends a failure back to the brewer's session.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  type SendBackCheck,
  sendBackChecks,
  sendBackLines,
  sendBackMessage,
} from '../../src/brewers/send-back.ts';
import type { RepositoryChecks } from '../../src/checks/gravity.ts';

const all: SendBackCheck[] = [
  { check: 'build', command: 'npm run build', files: false },
  { check: 'typecheck', command: 'tsc', files: true },
  { check: 'lint', command: 'biome lint', files: true },
  { check: 'format', command: 'biome format', files: true },
  { check: 'test', command: 'node --test', files: true },
];

const named = (checks: readonly SendBackCheck[], names: readonly string[]): SendBackCheck[] =>
  checks.filter(({ check }) => names.includes(check));

describe('sendBackLines (ADR 0381)', () => {
  it("the send-back's checks take the changed files and the red tests only", () => {
    const lines = sendBackLines(all, ['src/a.ts', 'src/b c.ts'], ['test/a.test.ts']);
    assert.deepEqual(lines, [
      // Build and typecheck read the whole project, whatever their line says.
      { check: 'build', command: 'npm run build' },
      { check: 'typecheck', command: 'tsc' },
      { check: 'lint', command: 'biome lint "src/a.ts" "src/b c.ts"' },
      { check: 'format', command: 'biome format "src/a.ts" "src/b c.ts"' },
      { check: 'test', command: 'node --test "test/a.test.ts"' },
    ]);
  });

  it('runs lint and format whole when their line takes no files', () => {
    const whole = all.map((check) => ({ ...check, files: false }));
    const lines = sendBackLines(named(whole, ['lint', 'format']), ['src/a.ts'], []);
    assert.deepEqual(lines, [
      { check: 'lint', command: 'biome lint' },
      { check: 'format', command: 'biome format' },
    ]);
  });

  it('never runs the test line whole: not when it takes no files, nor without red tests', () => {
    const whole = { check: 'test', command: 'node --test', files: false } as const;
    assert.deepEqual(sendBackLines([whole], ['src/a.ts'], ['test/a.test.ts']), []);
    assert.deepEqual(sendBackLines(named(all, ['test']), ['src/a.ts'], []), []);
  });

  it('skips lint and format that take files when the commits left no file', () => {
    assert.deepEqual(sendBackLines(named(all, ['lint', 'format']), [], []), []);
  });

  it('runs lint and format whole when the changed files could not be listed', () => {
    assert.deepEqual(sendBackLines(named(all, ['lint']), undefined, []), [
      { check: 'lint', command: 'biome lint' },
    ]);
  });

  it('runs lint whole when a changed path is not one a shell line can name safely', () => {
    for (const path of ['src/$(id).ts', 'src/a`b`.ts', 'src/"q".ts', 'src/%PATH%.ts', '-rf']) {
      assert.deepEqual(
        sendBackLines(named(all, ['lint']), ['src/a.ts', path], []),
        [{ check: 'lint', command: 'biome lint' }],
        path,
      );
    }
  });

  it('leaves out of the test line a red test file a shell line cannot name safely', () => {
    const lines = sendBackLines(named(all, ['test']), [], ['test/$(id).test.ts', 'test/b.test.ts']);
    assert.deepEqual(lines, [{ check: 'test', command: 'node --test "test/b.test.ts"' }]);
    assert.deepEqual(sendBackLines(named(all, ['test']), [], ['test/!x.test.ts']), []);
  });

  it('runs lint whole when the files would make its line too long for cmd.exe', () => {
    const changed = Array.from({ length: 400 }, (_, n) => `src/module-${n}/index.ts`);
    assert.deepEqual(sendBackLines(named(all, ['lint']), changed, []), [
      { check: 'lint', command: 'biome lint' },
    ]);
  });
});

describe('sendBackChecks (ADR 0381)', () => {
  it("lists the repository's checks it has, in green's order, with the platform's line", () => {
    const repository: RepositoryChecks = {
      build: null,
      typecheck: 'tsc',
      lint: { run: 'biome lint', windows: 'biome.cmd lint', files: true },
      format: null,
      test: { run: 'node --test', files: true },
    };
    assert.deepEqual(sendBackChecks(repository, 'win32'), [
      { check: 'typecheck', command: 'tsc', files: false },
      { check: 'lint', command: 'biome.cmd lint', files: true },
      { check: 'test', command: 'node --test', files: true },
    ]);
  });
});

describe('sendBackMessage (ADR 0381)', () => {
  it('names the check and its line, and quotes the end of what it printed', () => {
    const message = sendBackMessage({
      result: 'exited',
      check: 'lint',
      command: 'biome lint "src/a.ts"',
      exitCode: 1,
      tail: 'src/a.ts:3 noUnusedVariables',
    });
    assert.match(message, /^The checks Foedrum ran after your session found a failure\./);
    assert.match(message, /lint \(`biome lint "src\/a\.ts"`\) exited with 1/);
    assert.match(message, /src\/a\.ts:3 noUnusedVariables/);
    assert.match(message, /commit/);
  });

  it('says a check that did not end by itself was killed or could not start', () => {
    const killed = sendBackMessage({
      result: 'killed',
      check: 'build',
      command: 'npm run build',
      killed: 'timed-out',
      tail: '',
    });
    assert.match(killed, /build \(`npm run build`\) was killed: timed-out/);
    const unstarted = sendBackMessage({
      result: 'unstarted',
      check: 'build',
      command: 'npm run build',
      tail: 'spawn ENOENT',
    });
    assert.match(unstarted, /build \(`npm run build`\) could not start/);
  });
});
