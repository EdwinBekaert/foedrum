import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  type BranchFact,
  type Facts,
  plan,
  type WorktreeFact,
} from '../../scripts/worktrees-clean/core.ts';

const worktree = (name: string, fact: Partial<WorktreeFact> = {}): WorktreeFact => ({
  path: `/repo/.claude/worktrees/${name}`,
  inside: name,
  branch: name,
  lockReason: undefined,
  state: 'clean',
  record: `/repo/.git/worktrees/${name}`,
  ...fact,
});

// Merged, with an upstream branch that GitHub deleted on merge.
const branch = (name: string, fact: Partial<BranchFact> = {}): BranchFact => ({
  name,
  merged: true,
  upstream: `origin/${name}`,
  upstreamGone: true,
  ...fact,
});

const LIVE = 100;
const isPidAlive = (pid: number): boolean => pid === LIVE;
const run = (facts: Facts) => plan(facts, isPidAlive);

describe('plan: worktrees under .claude/worktrees/', () => {
  it('removes a clean worktree whose branch is merged and whose remote branch is gone', () => {
    const result = run({ worktrees: [worktree('7-a')], branches: [branch('7-a')] });

    assert.deepEqual(result.actions, [
      {
        kind: 'remove',
        label: '.claude/worktrees/7-a',
        path: '/repo/.claude/worktrees/7-a',
        record: '/repo/.git/worktrees/7-a',
        unlock: false,
        branch: '7-a',
      },
    ]);
    assert.deepEqual(result.kept, []);
  });

  // A detached worktree has no branch, so there is no branch fact for it either.
  const keptFor = (fact: Partial<WorktreeFact>, branchFact: Partial<BranchFact> = {}) =>
    run({
      worktrees: [worktree('7-a', fact)],
      branches: 'branch' in fact && fact.branch === undefined ? [] : [branch('7-a', branchFact)],
    });

  for (const [title, fact, branchFact, reason] of [
    ['unmerged', {}, { merged: false }, 'not merged'],
    ['the remote branch still exists', {}, { upstreamGone: false }, 'remote branch still exists'],
    ['no upstream', {}, { upstream: undefined, upstreamGone: false }, 'no upstream'],
    [
      'the upstream is origin/main',
      {},
      { upstream: 'origin/main', upstreamGone: true },
      'no upstream',
    ],
    ['uncommitted or untracked changes', { state: 'dirty' }, {}, 'changes'],
    [
      'a lock by a live session',
      { lockReason: `claude session 7-a (pid ${LIVE})` },
      {},
      'live session',
    ],
    ['a lock for another reason', { lockReason: 'on a USB drive' }, {}, 'on a USB drive'],
    ['no branch', { branch: undefined }, {}, 'no branch'],
  ] as const) {
    it(`keeps a worktree with ${title}`, () => {
      const result = keptFor(fact, branchFact);

      assert.deepEqual(result.actions, []);
      assert.equal(result.kept.length, 1);
      assert.match(result.kept[0] ?? '', /^kept worktree \.claude\/worktrees\/7-a: /);
      assert.ok(result.kept[0]?.includes(reason), result.kept[0]);
    });
  }

  it('unlocks a worktree whose session pid is gone', () => {
    const result = keptFor({ lockReason: 'claude session 7-a (pid 200)' });

    assert.equal(result.actions[0]?.kind, 'remove');
    assert.ok(result.actions[0]?.kind === 'remove' && result.actions[0].unlock);
  });

  it('finishes a folder without its .git file when its branch may go', () => {
    const result = keptFor({ state: 'no-git' });

    assert.deepEqual(result.actions, [
      {
        kind: 'finish',
        label: '.claude/worktrees/7-a',
        path: '/repo/.claude/worktrees/7-a',
        record: '/repo/.git/worktrees/7-a',
        branch: '7-a',
      },
    ]);
  });

  it('keeps a folder without its .git file when its branch must stay', () => {
    const result = keptFor({ state: 'no-git' }, { upstreamGone: false });

    assert.deepEqual(result.actions, []);
    assert.ok(result.kept[0]?.includes('remote branch still exists'), result.kept[0]);
  });

  it('prunes the record of a folder that is gone, nested or not, and keeps the branch that must stay', () => {
    const result = run({
      worktrees: [
        worktree('7-a', { state: 'gone' }),
        worktree('8-b/.foedrum/tmp/8/scratch/tree', { state: 'gone', branch: undefined }),
      ],
      branches: [branch('7-a', { merged: false })],
    });

    assert.deepEqual(result.actions, [
      {
        kind: 'prune',
        label: '.claude/worktrees/7-a',
        record: '/repo/.git/worktrees/7-a',
        branch: undefined,
      },
      {
        kind: 'prune',
        label: '.claude/worktrees/8-b/.foedrum/tmp/8/scratch/tree',
        record: '/repo/.git/worktrees/8-b/.foedrum/tmp/8/scratch/tree',
        branch: undefined,
      },
    ]);
  });

  it('prunes a gone record and deletes its branch when the branch may go', () => {
    const result = run({
      worktrees: [worktree('7-a', { state: 'gone' })],
      branches: [branch('7-a')],
    });

    assert.equal(result.actions[0]?.kind === 'prune' && result.actions[0].branch, '7-a');
  });

  it('keeps the record of a gone folder that a live session still locks', () => {
    const lockReason = `claude session 7-a (pid ${LIVE})`;
    const result = run({
      worktrees: [worktree('7-a', { state: 'gone', lockReason })],
      branches: [],
    });

    assert.deepEqual(result.actions, []);
    assert.ok(result.kept[0]?.includes('live session'), result.kept[0]);
  });

  it('leaves nested worktrees whose folder exists, and worktrees outside, alone', () => {
    const result = run({
      worktrees: [
        worktree('8-b/.foedrum/tmp/8/scratch/tree', { branch: undefined }),
        worktree('outside', { inside: undefined, path: '/elsewhere/outside' }),
        worktree('main', { inside: undefined, path: '/repo' }),
      ],
      branches: [branch('outside'), branch('main', { upstream: 'origin/main' })],
    });

    assert.deepEqual(result, { actions: [], kept: [] });
  });
});

describe('plan: branches without a worktree', () => {
  it('deletes a branch that is merged and whose remote branch is gone', () => {
    const result = run({ worktrees: [], branches: [branch('15-a')] });

    assert.deepEqual(result.actions, [{ kind: 'delete-branch', branch: '15-a' }]);
  });

  it('keeps branches that must stay, with the reason', () => {
    const result = run({
      worktrees: [],
      branches: [
        branch('main', { upstream: 'origin/main', upstreamGone: false }),
        branch('develop', { upstreamGone: false }),
        branch('16-open', { merged: false, upstream: undefined, upstreamGone: false }),
        branch('17-local', { upstream: undefined, upstreamGone: false }),
      ],
    });

    assert.deepEqual(result.actions, []);
    assert.deepEqual(result.kept, [
      'kept branch main: no upstream branch of its own',
      'kept branch develop: its remote branch still exists',
      'kept branch 16-open: not merged into origin/main',
      'kept branch 17-local: no upstream branch of its own',
    ]);
  });

  it('leaves a branch checked out in any worktree to the worktree pass', () => {
    const result = run({
      worktrees: [worktree('outside', { inside: undefined, path: '/elsewhere/outside' })],
      branches: [branch('outside')],
    });

    assert.deepEqual(result, { actions: [], kept: [] });
  });
});
