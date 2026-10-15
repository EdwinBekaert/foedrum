// Real git for the worktree cleanup's shell (ADR 0021): a bare origin, the main checkout, and
// a second clone that merges with a merge commit and deletes the head branch, as GitHub does.

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { parseWorktreeList } from '../../scripts/worktrees-clean/porcelain.ts';
import { removeTree } from '../../src/platform/remove.ts';
import { makeReadOnly } from '../helpers/read-only.ts';
import { makeTempDir, type TempDir } from '../helpers/temp-dir.ts';

const script = join(import.meta.dirname, '..', '..', 'scripts', 'worktrees-clean.ts');

const git = (cwd: string, args: string[]): string =>
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=t@example.com', ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

const lines = (text: string): string[] => text.split('\n').filter((line) => line !== '');

describe('worktrees-clean with real git', () => {
  let dir: TempDir;
  let main: string;
  let hub: string;
  beforeEach(() => {
    dir = makeTempDir('clean');
    const origin = join(dir.path, 'origin.git');
    main = join(dir.path, 'main');
    hub = join(dir.path, 'hub');
    git(dir.path, ['init', '-q', '--bare', '-b', 'main', origin]);
    git(dir.path, ['init', '-q', '-b', 'main', main]);
    writeFileSync(join(main, '.gitignore'), '.claude/worktrees/\n');
    git(main, ['add', '.gitignore']);
    git(main, ['commit', '-q', '-m', 'Initial commit']);
    git(main, ['remote', 'add', 'origin', origin]);
    git(main, ['push', '-q', '-u', 'origin', 'main']);
    git(main, ['remote', 'set-head', 'origin', 'main']);
    git(dir.path, ['clone', '-q', origin, hub]);
  });
  afterEach(() => removeTree(dir.path));

  const worktree = (name: string, { push = true } = {}): string => {
    const path = join(main, '.claude', 'worktrees', name);
    git(main, ['worktree', 'add', '-q', '-b', name, path, 'origin/main']);
    writeFileSync(join(path, `${name}.txt`), `${name}\n`);
    git(path, ['add', `${name}.txt`]);
    git(path, ['commit', '-q', '-m', `Work on ${name}`]);
    if (push) git(path, ['push', '-q', '-u', 'origin', name]);
    return path;
  };
  const merge = (branch: string, { deleteBranch = true } = {}): void => {
    git(hub, ['fetch', '-q', 'origin']);
    git(hub, ['merge', '-q', '--no-ff', '-m', `Merge ${branch}`, `origin/${branch}`]);
    git(hub, ['push', '-q', 'origin', 'main']);
    if (deleteBranch) git(hub, ['push', '-q', 'origin', '--delete', branch]);
  };
  const branches = (): string[] =>
    lines(git(main, ['for-each-ref', '--format=%(refname:short)', 'refs/heads']));
  const worktrees = (): string[] =>
    lines(git(main, ['worktree', 'list', '--porcelain'])).filter((l) => l.startsWith('worktree '));
  const clean = (cwd: string, args: string[] = []) =>
    spawnSync(process.execPath, [script, ...args], {
      cwd,
      encoding: 'utf8',
      env: { ...process.env, CLAUDE_PROJECT_DIR: cwd },
    });

  it('removes merged worktrees whose remote branch is gone, at session start in the main checkout only', () => {
    const merged = worktree('7-merged');
    // A committed file in a subfolder: a read-only folder stops git from deleting what is in
    // it on Linux and macOS, so the removal works only when the cleanup clears the bits first.
    mkdirSync(join(merged, 'docs'));
    writeFileSync(join(merged, 'docs', 'notes.md'), 'notes\n');
    git(merged, ['add', 'docs']);
    git(merged, ['commit', '-q', '-m', 'Add notes']);
    git(merged, ['push', '-q', 'origin', '7-merged']);
    const develop = worktree('8-develop');
    const open = worktree('9-open');
    const dirty = worktree('10-dirty');
    merge('7-merged');
    merge('8-develop', { deleteBranch: false });
    merge('10-dirty');
    writeFileSync(join(dirty, 'notes.txt'), 'not committed\n');
    // Read-only files and folders, as Windows sometimes leaves them.
    for (const entry of [join('docs', 'notes.md'), 'docs', ...readdirSync(merged)]) {
      const path = join(merged, entry);
      if (entry !== '.git') chmodSync(path, statSync(path).mode & ~0o222);
    }

    const insideWorktree = clean(open, ['--session-start']);
    assert.equal(insideWorktree.status, 0, insideWorktree.stderr);
    assert.equal(insideWorktree.stdout, '');
    assert.ok(existsSync(merged));

    const result = clean(main, ['--session-start']);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(merged), false, result.stdout);
    for (const path of [develop, open, dirty]) assert.ok(existsSync(path), result.stdout);
    assert.deepEqual(branches(), ['10-dirty', '8-develop', '9-open', 'main']);
    assert.match(result.stdout, /removed worktree \.claude\/worktrees\/7-merged/);
    assert.match(result.stdout, /deleted branch 7-merged/);
  });

  it('finishes a worktree folder whose .git file is gone and whose branch may go', () => {
    const half = worktree('11-half');
    merge('11-half');
    rmSync(join(half, '.git'));

    const result = clean(main);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(half), false, result.stdout);
    assert.equal(worktrees().length, 1, result.stdout);
    assert.deepEqual(branches(), ['main']);
  });

  it('prunes stale records at any depth, relative ones too, and keeps live sessions', () => {
    git(main, ['config', 'worktree.useRelativePaths', 'true']);
    const parent = worktree('12-parent', { push: false });
    const scratch = join(parent, '.foedrum', 'tmp', '12', 'scratch', 'tree');
    git(main, ['worktree', 'add', '-q', '--detach', scratch, 'origin/main']);
    rmSync(scratch, { recursive: true, force: true });
    const live = worktree('13-live');
    merge('13-live');
    git(main, [
      'worktree',
      'lock',
      '--reason',
      `claude session 13-live (pid ${process.pid})`,
      live,
    ]);
    // The unit tests' fixture still matches what this git prints.
    const listed = parseWorktreeList(git(main, ['worktree', 'list', '--porcelain', '-z']));
    const liveEntry = listed.find(({ branch }) => branch === '13-live');
    assert.equal(liveEntry?.lockReason, `claude session 13-live (pid ${process.pid})`);
    assert.ok(
      listed.some(({ path, branch }) => branch === undefined && path.endsWith('scratch/tree')),
    );

    const result = clean(main);

    assert.equal(result.status, 0, result.stderr);
    assert.ok(existsSync(parent) && existsSync(live), result.stdout);
    assert.equal(worktrees().length, 3, result.stdout);
    assert.match(result.stdout, /scratch\/tree: folder is gone/);
    assert.match(
      result.stdout,
      /kept worktree \.claude\/worktrees\/13-live: locked by a live session/,
    );
  });

  it('removes read-only records git no longer lists, outside .claude/worktrees/ too', () => {
    // A review run from the main checkout, whose removal stopped after deleting the gitdir file.
    const scratch = join(main, '.foedrum', 'tmp', '14', 'scratch', 'tree');
    git(main, ['worktree', 'add', '-q', '--detach', scratch, 'origin/main']);
    const record = join(main, '.git', 'worktrees', 'tree');
    rmSync(join(main, '.foedrum'), { recursive: true, force: true });
    rmSync(join(record, 'gitdir'));
    makeReadOnly(record);
    assert.equal(worktrees().length, 1);

    const result = clean(main);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(record), false, result.stdout);
    assert.match(
      result.stdout,
      /removed stale worktree record \.git\/worktrees\/tree: its gitdir file is missing/,
    );
  });
});
