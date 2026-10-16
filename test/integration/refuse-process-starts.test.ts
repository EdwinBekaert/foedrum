// The preload of npm test refuses process starts in the test processes under the real node:test
// runner (ADR 0021, #111), also through a module the test imports and when the code under test
// catches the refusal, while the runner itself still starts the test processes.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, it } from 'node:test';

const root = join(import.meta.dirname, '..', '..');
const fixtures = 'test/fixtures/process-starts/unit';

const PRELOAD = './scripts/test-cpu-time.ts';
// Imports node:child_process before npm test's preload replaces its functions.
const LOAD_FIRST = './test/fixtures/process-starts/load-child-process-first.ts';

// node --test on one fixture, with the given --import modules, killed after 60 s.
const run = (fixture: string, imports: readonly string[]) => {
  const result = spawnSync(
    process.execPath,
    [
      ...imports.flatMap((module) => ['--import', module]),
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
      const result = run(fixture, []);
      assert.equal(result.status, 0, result.stdout + result.stderr);
    });

    it(`${fixture} fails with the ADR 0021 message under npm test's preload`, () => {
      const result = run(fixture, [PRELOAD]);
      assert.equal(result.status, 1, result.stdout + result.stderr);
      assert.match(result.stdout, ADR_0021);
      assert.match(result.stdout, starter);
    });
  }

  // syncBuiltinESMExports is what makes this case refuse: without it, the built-in's ES module
  // keeps the functions it copied before the preload ran.
  it('refuses named, namespace and dynamic imports when child_process was imported first', () => {
    const fixture = 'loaded-first.test.ts';
    assert.equal(run(fixture, [LOAD_FIRST]).status, 0);
    const result = run(fixture, [LOAD_FIRST, PRELOAD]);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stdout, ADR_0021);
    for (const kind of ['named', 'namespace', 'dynamic']) {
      assert.match(result.stdout, new RegExp(`^✖ starts node through a ${kind} import`, 'm'));
    }
  });
});
