import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { parseWorktreeList } from '../../src/workspace/worktree-list.ts';

// Captured from git 2.56 with machine paths and object ids replaced.
const captured: string = JSON.parse(
  readFileSync(
    join(
      import.meta.dirname,
      '..',
      'fixtures',
      'worktrees-clean',
      'worktree-list-porcelain-z.json',
    ),
    'utf8',
  ),
);

describe('parseWorktreeList', () => {
  it('reads path, branch and lock reason from captured git output', () => {
    assert.deepEqual(parseWorktreeList(captured), [
      { path: '/work/repo', branch: 'main', lockReason: undefined },
      { path: '/work/repo/.claude/worktrees/10-gone', branch: '10-gone', lockReason: undefined },
      { path: '/work/repo/.claude/worktrees/7-merged', branch: '7-merged', lockReason: undefined },
      {
        path: '/work/repo/.claude/worktrees/7-merged/.foedrum/tmp/7/scratch/tree',
        branch: undefined,
        lockReason: undefined,
      },
      {
        path: '/work/repo/.claude/worktrees/8-locked',
        branch: '8-locked',
        lockReason: 'claude session 8-locked (pid 4242)',
      },
      { path: '/work/repo/.claude/worktrees/9-plain-lock', branch: '9-plain-lock', lockReason: '' },
    ]);
  });

  it('returns nothing for empty output', () => {
    assert.deepEqual(parseWorktreeList(''), []);
  });
});
