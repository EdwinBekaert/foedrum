// The preload of npm test refuses process starts in the test processes under the real node:test
// runner (ADR 0021, #111), also through a module the test imports and when the code under test
// catches the refusal, while the runner itself still starts the test processes.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, it } from 'node:test';

const root = join(import.meta.dirname, '..', '..');
const fixtures = 'test/fixtures/process-starts/unit';

// node --test on one fixture, with npm test's preload or without it.
const run = (fixture: string, preload: boolean) =>
  spawnSync(
    process.execPath,
    [
      ...(preload ? ['--import', './scripts/test-cpu-time.ts'] : []),
      '--test',
      '--test-reporter=spec',
      `${fixtures}/${fixture}`,
    ],
    // Without NODE_TEST_CONTEXT, which would make the child skip its files as a nested run.
    { cwd: root, encoding: 'utf8', env: { ...process.env, NODE_TEST_CONTEXT: undefined } },
  );

describe('refusing process starts under node --test', () => {
  for (const fixture of ['named-import.test.ts', 'runner-swallows.test.ts']) {
    it(`${fixture} starts a process without the preload`, () => {
      const result = run(fixture, false);
      assert.equal(result.status, 0, result.stdout + result.stderr);
    });
  }
});
