// The test map's second coverage report on a module with no coverage (#1175, ADR 0430).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { TestMap } from '../../src/schemas/test-map.ts';

const mapWith = (coverage: unknown) => ({
  derivedFrom: { globs: ['**/package.json'], paths: ['package.json'] },
  modules: [
    {
      name: 'web',
      code: ['web/**'],
      tests: { inline: true },
      testReport: { format: 'tap', path: 'tap.txt' },
      coverage,
      coverageSecond: { format: 'lcov', path: 'it.info' },
    },
  ],
});

describe('TestMap: a second coverage report needs a coverage (ADR 0430)', () => {
  it('refuses a coverageSecond on a module whose coverage is none, pointing at it', () => {
    const parsed = TestMap.safeParse(mapWith('none'));
    assert.equal(parsed.success, false);
    assert.deepEqual(
      parsed.error?.issues.map(({ path }) => path),
      [['modules', 0, 'coverageSecond']],
    );
  });

  it('accepts the same module once its coverage names a report', () => {
    const parsed = TestMap.safeParse(mapWith({ format: 'lcov', path: 'lcov.info' }));
    assert.equal(parsed.success, true);
  });
});
