// The merge of the base before a batch's last check (ADR 0164), the shell, on a fake git that
// records every call (ADR 0021): git runs in the worktree through its record under the clone,
// never by discovery (ADR 0029), a merge found after a kill is read from HEAD and its parents, one
// left in progress is aborted (ADR 0033), and a failed merge with nothing in conflict throws
// git's reason.

import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { type BaseMerge, baseMergeTarget } from '../../src/engine/base-merge.ts';
import { openWorktreeMerge } from '../../src/workspace/base-merge-git.ts';
import type { GitResult } from '../../src/workspace/git.ts';
import { type Answer, failed, fakeGit, ok, suiteFolders } from '../helpers/attempt-worktrees.ts';

const START = 'a'.repeat(40);
const TIP = 'b'.repeat(40);
const MERGED = 'c'.repeat(40);
const KEY = '["12-1","green",1,"merge_base"]';
const nextFolder = suiteFolders('base-merge-git');

/** git's own refusal of a merge that would overwrite an untracked file, captured from git 2.56. */
const OVERWRITE: GitResult = {
  code: 2,
  stdout: '',
  stderr:
    'error: The following untracked working tree files would be overwritten by merge:\n\tother.txt\nPlease move or remove them before you merge.\nAborting\nMerge with strategy ort failed.\n',
};

/**
 * A clone with one worktree record, whose gitdir file names the worktree at `path`, and a fake
 * git that names the clone's common directory and answers the calls in the worktree by `answer`,
 * given the arguments after `--git-dir` and `--work-tree`.
 */
const worktreeIn = (answer: Answer) => {
  const folder = nextFolder();
  const clone = join(folder, 'clone');
  const common = join(clone, '.git');
  const record = join(common, 'worktrees', 'tree');
  const path = join(folder, 'tree');
  mkdirSync(record, { recursive: true });
  mkdirSync(path);
  writeFileSync(join(record, 'gitdir'), `${join(path, '.git')}\n`);
  const fake = fakeGit((cwd, args) => {
    if (args.includes('--git-common-dir')) return ok(`${common}\n`);
    return answer(cwd, args.slice(2));
  });
  const merge: BaseMerge = {
    base: 'main',
    push: { baseTip: async () => TIP, isAncestor: async () => false },
    worktree: openWorktreeMerge({ git: fake.git, clone }),
  };
  /** The calls in the worktree, without the record's two options, which each one leads with. */
  const inWorktree = () =>
    fake.calls.flatMap(([cwd, ...args]) => {
      if (cwd !== path) return [];
      assert.deepEqual(args.slice(0, 2), [`--git-dir=${record}`, `--work-tree=${path}`]);
      return [args.slice(2)];
    });
  return { clone, path, merge, calls: fake.calls, inWorktree };
};

const HEAD = ['rev-parse', '--verify', '--quiet', '--end-of-options', 'HEAD^{commit}'];
const MERGE_HEAD = ['rev-parse', '--verify', '--quiet', '--end-of-options', 'MERGE_HEAD'];
const same = (args: readonly string[], expected: readonly string[]) =>
  args.join(' ') === expected.join(' ');

describe('openWorktreeMerge, through baseMergeTarget (ADR 0164)', () => {
  it('finds the merge a killed run made from HEAD and its parents, read through the worktree record (ADR 0033, ADR 0029)', async () => {
    const tree = worktreeIn((_cwd, args) => {
      if (same(args, HEAD)) return ok(`${MERGED}\n`);
      if (args[0] === 'rev-list') return ok(`${MERGED} ${START} ${TIP}\n`);
      return undefined;
    });
    const target = baseMergeTarget(tree.merge, { path: tree.path, start: START }, 'green');
    assert.deepEqual(await target.find(KEY), { result: { base: TIP, merged: MERGED } });
    assert.deepEqual(tree.calls[0]?.slice(0, 2), [tree.clone, 'rev-parse']);
    assert.deepEqual(tree.inWorktree(), [
      HEAD,
      ['rev-list', '--parents', '--max-count=1', '--end-of-options', MERGED],
    ]);
  });

  it('aborts a merge a killed run left in progress, and finds nothing; aborts none when none is', async () => {
    for (const inProgress of [true, false]) {
      const tree = worktreeIn((_cwd, args) => {
        if (same(args, HEAD)) return ok(`${START}\n`);
        if (same(args, MERGE_HEAD)) return inProgress ? ok(`${TIP}\n`) : failed('');
        return undefined;
      });
      const target = baseMergeTarget(tree.merge, { path: tree.path, start: START }, 'green');
      assert.equal(await target.find(KEY), undefined);
      assert.deepEqual(tree.inWorktree(), [
        HEAD,
        MERGE_HEAD,
        ...(inProgress ? [['merge', '--abort']] : []),
      ]);
    }
  });

  it("throws with git's reason when the merge fails with nothing in conflict, and aborts nothing", async () => {
    const tree = worktreeIn((_cwd, args) => {
      if (args[0] === 'merge') return OVERWRITE;
      // git refused before it merged anything: no merge in progress, no file unmerged.
      if (same(args, MERGE_HEAD)) return failed('');
      return undefined;
    });
    const target = baseMergeTarget(tree.merge, { path: tree.path, start: START }, 'green');
    await assert.rejects(target.apply(KEY), {
      message:
        'git merge failed: error: The following untracked working tree files would be overwritten by merge:',
    });
    assert.deepEqual(tree.inWorktree(), [
      [
        'merge',
        '--no-ff',
        '--no-edit',
        '--no-verify',
        '-m',
        'Merge main before green',
        '--end-of-options',
        TIP,
      ],
      ['diff', '--no-ext-diff', '--name-only', '--diff-filter=U', '-z'],
      MERGE_HEAD,
    ]);
  });

  it('fails when the clone has no record of the worktree, before git runs in it', async () => {
    const tree = worktreeIn(() => undefined);
    const elsewhere = join(tree.path, '..', 'elsewhere');
    const target = baseMergeTarget(tree.merge, { path: elsewhere, start: START }, 'green');
    await assert.rejects(target.find(KEY), {
      message: `${tree.clone} has no record of the worktree ${elsewhere}`,
    });
    assert.deepEqual(tree.inWorktree(), []);
  });
});
