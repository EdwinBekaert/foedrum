import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isPidAlive, type Kill } from '../../src/platform/processes.ts';

const failingWith =
  (code: string): Kill =>
  () => {
    throw Object.assign(new Error(code), { code });
  };

describe('isPidAlive', () => {
  it('is true when signal 0 reaches the process', () => {
    assert.equal(
      isPidAlive(42, () => undefined),
      true,
    );
  });

  it('is false when the process does not exist', () => {
    assert.equal(isPidAlive(42, failingWith('ESRCH')), false);
  });

  // A live session of another user must not look ended, or its worktree would be removed.
  it('is true when the process exists but belongs to someone else', () => {
    assert.equal(isPidAlive(42, failingWith('EPERM')), true);
  });

  it('is true for the current process', () => {
    assert.equal(isPidAlive(process.pid), true);
  });
});
