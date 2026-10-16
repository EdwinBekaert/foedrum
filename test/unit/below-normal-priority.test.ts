// lowerPriority with the process's priority injected; test/integration/below-normal-priority.test.ts
// checks it on the real process and its children.

import assert from 'node:assert/strict';
import { constants } from 'node:os';
import { describe, it } from 'node:test';
import { lowerPriority } from '../../scripts/below-normal-priority.ts';

const { PRIORITY_BELOW_NORMAL, PRIORITY_LOW, PRIORITY_NORMAL } = constants.priority;

// Runs lowerPriority on a process at `priority` and returns the priorities it set.
const lowered = (env: NodeJS.ProcessEnv, priority: number, refuse = false): number[] => {
  const set: number[] = [];
  lowerPriority({
    env,
    getPriority: () => priority,
    setPriority: (value) => {
      if (refuse) throw new Error('EACCES: permission denied');
      set.push(value);
    },
  });
  return set;
};

describe('lowerPriority', () => {
  it('lowers a process at normal priority to below normal when CI is not set', () => {
    assert.deepEqual(lowered({}, PRIORITY_NORMAL), [PRIORITY_BELOW_NORMAL]);
  });

  it('treats an empty CI as not set', () => {
    assert.deepEqual(lowered({ CI: '' }, PRIORITY_NORMAL), [PRIORITY_BELOW_NORMAL]);
  });

  it('leaves the priority alone in CI', () => {
    assert.deepEqual(lowered({ CI: 'true' }, PRIORITY_NORMAL), []);
  });

  it('never raises a priority that is already lower', () => {
    assert.deepEqual(lowered({}, PRIORITY_LOW), []);
    assert.deepEqual(lowered({}, PRIORITY_BELOW_NORMAL), []);
  });

  it('carries on at the same priority when the system refuses the change', () => {
    assert.doesNotThrow(() => lowered({}, PRIORITY_NORMAL, true));
  });
});
