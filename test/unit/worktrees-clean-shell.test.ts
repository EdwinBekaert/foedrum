import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
// Object ids of 7-merged and 10-gone in refs.json (the same ids as in the worktree list).
const TIP_7 = '0000000000000000000000000000000000000003';
const TIP_10 = '0000000000000000000000000000000000000002';

type Call = [cwd: string, ...args: string[]];

// A fake git that answers from the captured output and records every call. `fail` names the
// calls that fail, by their arguments; `answer` replaces the output of some calls.
const fakeGit = (
  main: string,
  fail: (args: string[]) => boolean = () => false,
  answer: (cwd: string, args: string[]) => string | undefined = () => undefined,
) => {
  const calls: Call[] = [];
  const git: Git = async (cwd, args) => {
    calls.push([cwd, ...args]);
    if (fail(args)) return { ok: false, stdout: '', stderr: 'fatal: simulated failure\n' };
    const answered = answer(cwd, args);
    if (answered !== undefined) return { ok: true, stdout: answered, stderr: '' };
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

    // lstrip=2, not :short: git disambiguates :short (a branch next to a tag of the same name
    // becomes heads/<name>), and then it no longer matches the worktree list.
    const format =
      '--format=%(refname:lstrip=2)%00%(objectname)%00%(upstream:lstrip=2)%00%(upstream:track)';
    assert.deepEqual(calls, [
      [main, 'rev-parse', '--path-format=absolute', '--git-common-dir'],
      [main, 'fetch', '--prune', '--quiet', 'origin'],
      [main, 'worktree', 'list', '--porcelain', '-z'],
      [wt('7-merged'), 'status', '--porcelain'],
      [wt('9-plain-lock'), 'status', '--porcelain'],
      [main, 'for-each-ref', format, 'refs/heads'],
      [main, 'for-each-ref', '--format=%(refname:lstrip=2)', '--merged=origin/main', 'refs/heads'],
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
    // Nothing writes the branch's upstream or config (reading them with for-each-ref is fine).
    assert.equal(
      commands.some((c) => c.includes('--set-upstream-to') || c.includes('branch.7-merged')),
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

  // Without the list, no branch counts as checked out, and update-ref -d does not refuse one.
  for (const failing of ['worktree', 'for-each-ref'] as const) {
    it(`deletes nothing when git ${failing} fails`, async () => {
      const { calls, git } = fakeGit(main, (args) => args[0] === failing);

      const lines = await cleanWorktrees(main, git);

      const commands = calls.map(([, ...args]) => args.join(' '));
      assert.equal(
        commands.some((c) => /^(update-ref|worktree remove|config)/.test(c)),
        false,
      );
      assert.ok(existsSync(record('10-gone')));
      assert.equal(lines.length, 1, lines.join('\n'));
      assert.match(lines[0] ?? '', new RegExp(`^skipped: git ${failing} .*failed`));
    });
  }

  it('unlocks a worktree whose session has ended before removing it', async () => {
    const lock = `locked claude session 7-merged (pid ${process.pid})\0`;
    const list = (args: string[]) => args[0] === 'worktree' && args[1] === 'list';
    const { calls, git } = fakeGit(main, undefined, (_cwd, args) =>
      list(args)
        ? worktreeList
            .replaceAll('/work/repo', main)
            .replace('branch refs/heads/7-merged\0', `branch refs/heads/7-merged\0${lock}`)
        : undefined,
    );

    await cleanWorktrees(main, git, () => false);

    const commands = calls.map(([, ...args]) => args.join(' '));
    const unlock = commands.indexOf(`worktree unlock ${wt('7-merged')}`);
    assert.ok(unlock >= 0, commands.join('\n'));
    assert.ok(unlock < commands.indexOf(`worktree remove ${wt('7-merged')}`));
  });

  it('keeps the branch when the worktree cannot be removed', async () => {
    const { calls, git } = fakeGit(main, (args) => args[0] === 'worktree' && args[1] === 'remove');

    const lines = await cleanWorktrees(main, git);

    const commands = calls.map(([, ...args]) => args.join(' '));
    assert.equal(
      commands.some((c) => c.includes('refs/heads/7-merged')),
      false,
    );
    assert.equal(
      commands.some((c) => c.includes('branch.7-merged')),
      false,
    );
    assert.ok(
      lines.includes('could not clean .claude/worktrees/7-merged: fatal: simulated failure'),
    );
  });

  it('finishes a worktree that git removed part-way, once its .git file is gone', async () => {
    // git deletes what it can, then fails on a busy file; it took the .git file and the record.
    const { calls, git } = fakeGit(main, (args) => {
      if (args[0] !== 'worktree' || args[1] !== 'remove') return false;
      rmSync(join(wt('7-merged'), '.git'));
      rmSync(record('7-merged'), { recursive: true });
      return true;
    });

    const lines = await cleanWorktrees(main, git);

    assert.equal(existsSync(wt('7-merged')), false, lines.join('\n'));
    assert.ok(lines.includes('removed worktree .claude/worktrees/7-merged'), lines.join('\n'));
    const commands = calls.map(([, ...args]) => args.join(' '));
    assert.ok(commands.includes(`update-ref -d refs/heads/7-merged ${TIP_7}`));
  });

  it('keeps the config and reports the branch when update-ref refuses it', async () => {
    const { calls, git } = fakeGit(
      main,
      (args) => args[0] === 'update-ref' && args[2] === 'refs/heads/7-merged',
    );

    const lines = await cleanWorktrees(main, git);

    const commands = calls.map(([, ...args]) => args.join(' '));
    assert.equal(commands.includes('config --remove-section branch.7-merged'), false);
    assert.equal(lines.includes('deleted branch 7-merged'), false);
    assert.ok(lines.some((line) => line.startsWith('could not clean branch 7-merged')));
  });

  it('runs nothing outside a git repository', async () => {
    const { calls, git } = fakeGit(main, (args) => args[0] === 'rev-parse');

    const lines = await cleanWorktrees(main, git);

    assert.deepEqual(
      calls.map(([, command]) => command),
      ['rev-parse'],
    );
    assert.deepEqual(lines, ['skipped: not inside a git repository']);
  });

  it('removes records git does not list, wherever their worktree was, and reports each', async () => {
    // Left by a review scratch tree that git removed part-way: no gitdir file at all.
    mkdirSync(record('tree'), { recursive: true });
    mkdirSync(record('tree1'), { recursive: true });
    writeFileSync(join(record('tree1'), 'gitdir'), `${join(dir.path, 'gone', 'tree')}/.git\n`);
    const { git } = fakeGit(main);

    const lines = await cleanWorktrees(main, git);

    assert.equal(existsSync(record('tree')), false, lines.join('\n'));
    assert.equal(existsSync(record('tree1')), false, lines.join('\n'));
    assert.ok(existsSync(record('9-plain-lock')));
    assert.ok(
      lines.includes(
        'removed stale worktree record .git/worktrees/tree: its gitdir file is missing',
      ),
      lines.join('\n'),
    );
    assert.ok(
      lines.includes(
        `removed stale worktree record .git/worktrees/tree1: its folder ${join(dir.path, 'gone', 'tree')} is gone`,
      ),
      lines.join('\n'),
    );
  });

  it('matches a record whose path differs only in case', {
    skip: !['win32', 'darwin'].includes(process.platform) && 'case-sensitive file system',
  }, async () => {
    writeFileSync(join(record('10-gone'), 'gitdir'), `${wt('10-gone').toUpperCase()}/.git\n`);
    const { git } = fakeGit(main);

    const lines = await cleanWorktrees(main, git);

    assert.equal(existsSync(record('10-gone')), false, lines.join('\n'));
  });

  it('keeps a worktree whose status shows changes', async () => {
    const { calls, git } = fakeGit(main, undefined, (cwd, args) =>
      args[0] === 'status' && cwd === wt('7-merged') ? refs.statusDirty : undefined,
    );

    const lines = await cleanWorktrees(main, git);

    const commands = calls.map(([, ...args]) => args.join(' '));
    assert.equal(commands.includes(`worktree remove ${wt('7-merged')}`), false);
    assert.ok(
      lines.includes(
        'kept worktree .claude/worktrees/7-merged: it has uncommitted or untracked changes',
      ),
    );
  });
});
