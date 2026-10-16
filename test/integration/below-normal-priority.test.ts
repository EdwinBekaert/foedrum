// npm test's preload lowers the priority of the process that loads it on a developer's machine,
// and a process it starts inherits it (#140). That it changes nothing in CI is a unit test.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { constants, getPriority } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

const root = join(import.meta.dirname, '..', '..');

// Prints its own priority and that of a node it starts, as `<own> <child's>`.
const REPORT = [
  "const { getPriority } = require('node:os');",
  "const { execFileSync } = require('node:child_process');",
  "const child = execFileSync(process.execPath, ['-p', \"require('node:os').getPriority()\"], { encoding: 'utf8' });",
  'console.log(`${getPriority()} ${child.trim()}`);',
].join('\n');

// node with npm test's preload, without CI, killed after 60 s. Without NODE_TEST_CONTEXT too, so
// the preload treats it as the runner, which may start processes.
const priorities = (): string => {
  const result = spawnSync(process.execPath, ['--import', './scripts/test-cpu-time.ts', '-e', REPORT], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, CI: undefined, NODE_TEST_CONTEXT: undefined },
    timeout: 60_000,
  });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  return result.stdout.trim();
};

describe("npm test's preload and the process priority", () => {
  it('runs below normal without CI, and so does a process it starts', () => {
    const below = constants.priority.PRIORITY_BELOW_NORMAL;
    // A machine that already runs this test below normal or lower keeps that priority.
    const expected = Math.max(getPriority(), below);
    assert.equal(priorities(), `${expected} ${expected}`);
  });
});
