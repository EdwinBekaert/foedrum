import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { cleanWorktrees, type Git } from '../../scripts/worktrees-clean.ts';
import { makeTempDir, type TempDir } from '../helpers/temp-dir.ts';

// Captured from git 2.56 with machine paths and object ids replaced (see the fixture folder).
const fixtures = join(import.meta.dirname, '..', 'fixtures', 'worktrees-clean');
const worktreeList: string = JSON.parse(
  readFileSync(join(fixtures, 'worktree-list-porcelain-z.json'), 'utf8'),
);
const refs: { forEachRef: string; merged: string; statusDirty: string } = JSON.parse(
  readFileSync(join(fixtures, 'refs.json'), 'utf8'),
);
// Object ids of 7-merged and 10-gone in refs.json.
const TIP_7 = '0000000000000000000000000000000000000002';
const TIP_10 = '0000000000000000000000000000000000000001';

type Call = [cwd: string, ...args: string[]];

// A fake git that answers from the captured output and records every call. `fail` names the
// calls that fail, by their arguments.
const fakeGit = (main: string, fail: (args: string[]) => boolean = () => false) => {
  const calls: Call[] = [];
  const git: Git = async (cwd, args) => {
    calls.push([cwd, ...args]);
    if (fail(args)) return { ok: false, stdout: '', stderr: 'fatal: simulated failure\n' };
    const [command] = args;
    const stdout =
      command === 'rev-parse'
        ? `${main}/.git\n`
        : command === 'worktree' && args[1] === 'list'
          ? worktreeList.replaceAll('/work/repo', main)
          : command === 'for-each-ref'
            ? args.some((arg) => arg.startsWith('--merged'))
              ? refs.merged
              : refs.forEachRef
            : '';
    return { ok: true, stdout, stderr: '' };
  };
  return { calls, git };
};

describe('cleanWorktrees with a fake git', () => {
  let dir: TempDir;
  let main: string;
  const wt = (name: string): string => `${main}/.claude/worktrees/${name}`;
  const record = (name: string): string => join(dir.path, '.git', 'worktrees', name);

  // On disk: 7-merged and 9-plain-lock are worktrees with a .git file; 10-gone has only its
  // record left; 8-locked and the nested scratch tree are not there at all.
  beforeEach(() => {
    dir = makeTempDir('shell');
    main = dir.path.replaceAll('\\', '/');
    for (const name of ['7-merged', '9-plain-lock']) {
      mkdirSync(wt(name), { recursive: true });
      writeFileSync(join(wt(name), '.git'), `gitdir: ${record(name)}\n`);
    }
    for (const name of ['7-merged', '9-plain-lock', '10-gone']) {
      mkdirSync(record(name), { recursive: true });
      writeFileSync(join(record(name), 'gitdir'), `${wt(name)}/.git\n`);
    }
  });
  afterEach(() => dir.remove());

  it('removes one worktree, prunes one record and keeps one locked worktree', async () => {
    const { calls, git } = fakeGit(main);

    const lines = await cleanWorktrees(main, git);

    const format =
      '--format=%(refname:short)%00%(objectname)%00%(upstream:short)%00%(upstream:track)';
    assert.deepEqual(calls, [
      [main, 'rev-parse', '--path-format=absolute', '--git-common-dir'],
      [main, 'fetch', '--prune', '--quiet', 'origin'],
      [main, 'worktree', 'list', '--porcelain', '-z'],
      [wt('7-merged'), 'status', '--porcelain'],
      [wt('9-plain-lock'), 'status', '--porcelain'],
      [main, 'for-each-ref', format, 'refs/heads'],
      [main, 'for-each-ref', '--format=%(refname:short)', '--merged=origin/main', 'refs/heads'],
      // 10-gone: the record goes on disk, then the branch, only while it is still at the
      // checked tip and that tip is merged.
      [main, 'merge-base', '--is-ancestor', TIP_10, 'origin/main'],
      [main, 'update-ref', '-d', 'refs/heads/10-gone', TIP_10],
      [main, 'config', '--remove-section', 'branch.10-gone'],
      [main, 'worktree', 'remove', wt('7-merged')],
      [main, 'merge-base', '--is-ancestor', TIP_7, 'origin/main'],
      [main, 'update-ref', '-d', 'refs/heads/7-merged', TIP_7],
      [main, 'config', '--remove-section', 'branch.7-merged'],
    ]);
    assert.equal(existsSync(record('10-gone')), false);
    assert.ok(existsSync(record('9-plain-lock')));
    assert.ok(lines.includes('pruned stale worktree .claude/worktrees/10-gone: folder is gone'));
    assert.ok(lines.includes('removed worktree .claude/worktrees/7-merged'));
    assert.ok(lines.includes('deleted branch 7-merged'));
    assert.ok(
      lines.includes('kept worktree .claude/worktrees/9-plain-lock: locked: no reason given'),
    );
  });

  it('leaves a branch and its upstream alone when the merge check fails', async () => {
    const { calls, git } = fakeGit(main, (args) => args[0] === 'merge-base' && args[2] === TIP_7);

    const lines = await cleanWorktrees(main, git);

    const commands = calls.map(([, ...args]) => args.join(' '));
    assert.ok(commands.includes(`worktree remove ${wt('7-merged')}`));
    assert.equal(
      commands.some((command) => command.includes('refs/heads/7-merged')),
      false,
    );
    assert.equal(
      commands.some((command) => command.includes('upstream')),
      false,
    );
    assert.ok(
      lines.some((line) => line.startsWith('could not clean branch 7-merged')),
      lines.join('\n'),
    );
  });

  it('runs nothing after a failed fetch', async () => {
    const { calls, git } = fakeGit(main, (args) => args[0] === 'fetch');

    const lines = await cleanWorktrees(main, git);

    assert.deepEqual(
      calls.map(([, command]) => command),
      ['rev-parse', 'fetch'],
    );
    assert.equal(lines.length, 1);
    assert.match(lines[0] ?? '', /^skipped: git fetch --prune origin failed/);
  });
});
