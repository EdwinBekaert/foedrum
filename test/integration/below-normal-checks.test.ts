// A command line started below normal priority, as a Brett step's scratch-tree runs are (ADR 0413):
// through nice outside Windows, created below normal by the Job Object's helper on Windows, so the
// program its shell starts runs lower than this process, on every CI platform.

import assert from 'node:assert/strict';
import { constants, getPriority, setPriority } from 'node:os';
import { describe, it, type TestContext } from 'node:test';
import { execProcess } from '../../src/platform/processes.ts';
import { makeTempDir } from '../helpers/temp-dir.ts';

const below = constants.priority.PRIORITY_BELOW_NORMAL;

// The priority of a node the shell starts, with the options the check runner's runLine passes.
const childPriority = async (t: TestContext, belowNormal: boolean): Promise<number> => {
  const dir = makeTempDir('below-normal-checks');
  t.after(() => dir.remove());
  const line = `"${process.execPath}" -p "require('node:os').getPriority()"`;
  const result = await execProcess(line, [], {
    cwd: dir.path,
    shell: true,
    jobObject: true,
    belowNormal,
    timeoutMs: 60_000,
  });
  assert.equal(result.exitCode, 0, result.output);
  return Number(result.stdout.trim());
};

// A test process that already runs below normal (npm run test:integration on a developer's machine
// lowers itself) would pass its priority on to the child whatever the option does. Windows lets a
// process raise itself back to normal, so it does that for the test and lowers itself again after;
// elsewhere that takes privileges, and the test runs only where this process is above below normal,
// as in CI.
const skipWhenAlreadyLow = (t: TestContext): boolean => {
  const was = getPriority();
  if (was < below) return false;
  try {
    setPriority(constants.priority.PRIORITY_NORMAL);
  } catch {
    // Refused: left as it was.
  }
  if (getPriority() < below) {
    t.after(() => setPriority(was));
    return false;
  }
  t.skip(
    'this process already runs below normal and may not raise itself, so the child would inherit it',
  );
  return true;
};

describe('execProcess with belowNormal (ADR 0413)', () => {
  it('runs the program a command line starts below normal priority, lower than this process', async (t) => {
    if (skipWhenAlreadyLow(t)) return;
    const parent = getPriority();
    const child = await childPriority(t, true);
    assert.ok(child >= below && child > parent, `child ${child}, parent ${parent}`);
  });
});
