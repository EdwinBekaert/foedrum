// The preload of npm test refuses process starts in the test processes under the real node:test
// runner (ADR 0021, #111), also through a module the test imports and when the code under test
// catches the refusal, while the runner itself still starts the test processes.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, it } from 'node:test';

const root = join(import.meta.dirname, '..', '..');
const fixtures = 'test/fixtures/process-starts/unit';

// node --test on one fixture, with npm test's preload or without it, killed after 60 s.
const run = (fixture: string, preload: boolean) => {
  const result = spawnSync(
    process.execPath,
    [
      ...(preload ? ['--import', './scripts/test-cpu-time.ts'] : []),
      '--test',
      '--test-reporter=spec',
      `${fixtures}/${fixture}`,
    ],
    // Without NODE_TEST_CONTEXT, which would make the child skip its files as a nested run.
    {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, NODE_TEST_CONTEXT: undefined },
      timeout: 60_000,
    },
  );
  assert.equal(result.error, undefined, `${fixture}: ${result.error?.message}`);
  return result;
};

const ADR_0021 = /unit, property and chaos tests start no processes.*test\/integration\/.*ADR 0021/;

// Each fixture, and the module whose process start its failure names.
const FIXTURES = [
  ['named-import.test.ts', /node-version\.ts/],
  ['runner-swallows.test.ts', /src[/\\]platform[/\\]processes\.ts/],
] as const;

describe('refusing process starts under node --test', () => {
  for (const [fixture, starter] of FIXTURES) {
    it(`${fixture} starts a process without the preload`, () => {
      const result = run(fixture, false);
      assert.equal(result.status, 0, result.stdout + result.stderr);
    });

    it(`${fixture} fails with the ADR 0021 message under npm test's preload`, () => {
      const result = run(fixture, true);
      assert.equal(result.status, 1, result.stdout + result.stderr);
      assert.match(result.stdout, ADR_0021);
      assert.match(result.stdout, starter);
    });
  }
});
