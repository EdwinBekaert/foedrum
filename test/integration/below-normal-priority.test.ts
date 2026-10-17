// npm test's preload, and the priority preload of npm run test:integration and /brew-review's
// coverage runs, lower the priority of the process that loads them on a developer's machine, and a
// process it starts inherits it (#140). That they change nothing in CI is a unit test.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { constants, getPriority } from 'node:os';
import { join } from 'node:path';
import { describe, it, type TestContext } from 'node:test';

const root = join(import.meta.dirname, '..', '..');

// Prints its own priority and that of a node it starts, as `<own> <child's>`.
const REPORT = [
  "const { getPriority } = require('node:os');",
  "const { execFileSync } = require('node:child_process');",
  "const child = execFileSync(process.execPath, ['-p', \"require('node:os').getPriority()\"], { encoding: 'utf8' });",
  'console.log(`${getPriority()} ${child.trim()}`);',
].join('\n');

// node with a preload (npm test's by default), without CI, killed after 60 s. Without
// NODE_TEST_CONTEXT too, so npm test's preload treats it as the runner, which may start processes.
const priorities = (preload = './scripts/test-cpu-time.ts'): string => {
  const result = spawnSync(process.execPath, ['--import', preload, '-e', REPORT], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, CI: undefined, NODE_TEST_CONTEXT: undefined },
    timeout: 60_000,
  });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  return result.stdout.trim();
};

const below = constants.priority.PRIORITY_BELOW_NORMAL;

// A test process that already runs below normal (npm run test:integration on a developer's
// machine lowers itself) would pass its priority on to the probe whatever the preload does, so
// the check could not fail. It runs where this process is at normal priority, as in CI.
const skipWhenAlreadyLow = (t: TestContext): boolean => {
  if (getPriority() < below) return false;
  t.skip('this process already runs below normal, so the probe would inherit it');
  return true;
};

describe("npm test's preload and the process priority", () => {
  it('runs below normal without CI, and so does a process it starts', (t) => {
    if (skipWhenAlreadyLow(t)) return;
    assert.equal(priorities(), `${below} ${below}`);
  });

  it('runs below normal under the priority preload of the integration and coverage runs', (t) => {
    if (skipWhenAlreadyLow(t)) return;
    assert.equal(priorities('./scripts/lower-priority.ts'), `${below} ${below}`);
  });
});
