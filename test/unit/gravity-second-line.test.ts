// A repository's second test line in the plan of a check step's checks, and in doctor's line for
// the test gate (#1175, ADR 0430).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { planChecks, type RepositoryChecks, testGateOf } from '../../src/checks/gravity.ts';
import { coveragePaths } from '../../src/checks/module-reports.ts';
import type { TestMapModule } from '../../src/schemas/test-map.ts';

const repository: RepositoryChecks = {
  build: null,
  typecheck: 'npm run typecheck',
  lint: 'npm run lint',
  format: null,
  test: 'npm test',
  testSecond: { run: 'npm run integration', windows: 'npm.cmd run integration' },
};

describe('planChecks: the second test line (ADR 0430)', () => {
  it('runs the second line, a check of no name, right after the test check, on the platform', () => {
    assert.deepEqual(
      planChecks(['lint', 'test', 'typecheck'], repository, 'win32', undefined, true),
      [
        { kind: 'run', check: 'lint', command: 'npm run lint' },
        { kind: 'run', check: 'test', command: 'npm test' },
        { kind: 'run', command: 'npm.cmd run integration' },
        { kind: 'run', check: 'typecheck', command: 'npm run typecheck' },
      ],
    );
  });

  it('runs the second line after the testChanged line in its place, in full', () => {
    const changed = { ...repository, testChanged: 'npm test -- --changed {base}' };
    assert.deepEqual(planChecks(['test'], changed, 'linux', 'b'.repeat(40), true), [
      {
        kind: 'run',
        check: 'test',
        changed: true,
        command: `npm test -- --changed ${'b'.repeat(40)}`,
      },
      { kind: 'run', command: 'npm run integration' },
    ]);
  });

  it('plans no second line unless the step asks for it, or when the repository names none', () => {
    const test = [{ kind: 'run', check: 'test', command: 'npm test' }];
    assert.deepEqual(planChecks(['test'], repository, 'linux'), test);
    const without: RepositoryChecks = { ...repository, testSecond: undefined };
    assert.deepEqual(planChecks(['test'], without, 'linux', undefined, true), test);
  });

  it('plans no second line after a step without the test check', () => {
    assert.deepEqual(planChecks(['lint'], repository, 'linux', undefined, true), [
      { kind: 'run', check: 'lint', command: 'npm run lint' },
    ]);
  });
});

describe('testGateOf: the second test line (ADR 0430)', () => {
  it('says the check step runs the second line in full after the test', () => {
    assert.equal(
      testGateOf('acme/web', repository, 'linux'),
      'acme/web: the check step runs the full test (npm test); then its second test line, in full (npm run integration)',
    );
    const changed = { ...repository, testChanged: 'npm test -- --changed {base}' };
    assert.match(
      testGateOf('acme/web', changed, 'linux'),
      /runs only testChanged .*; then its second test line, in full \(npm run integration\)$/,
    );
  });
});

describe('coveragePaths (ADR 0430)', () => {
  const module: TestMapModule = {
    name: 'web',
    code: ['web/**'],
    tests: { inline: true },
    testReport: { format: 'tap', path: 'tap.txt' },
    coverage: { format: 'lcov', path: 'lcov.info' },
  };

  it("lists a module's coverage path and its second coverage path, each cleared before a run", () => {
    const second = { ...module, coverageSecond: { format: 'lcov' as const, path: 'it.info' } };
    assert.deepEqual(coveragePaths(second), ['lcov.info', 'it.info']);
    assert.deepEqual(coveragePaths(module), ['lcov.info']);
    assert.deepEqual(coveragePaths({ ...second, coverage: 'none' }), ['it.info']);
  });
});
