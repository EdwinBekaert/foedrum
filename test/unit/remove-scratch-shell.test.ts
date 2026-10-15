import assert from 'node:assert/strict';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { removeScratch } from '../../scripts/remove-scratch.ts';
import type { Git } from '../../scripts/worktrees-clean.ts';
import { makeTempDir, type TempDir } from '../helpers/temp-dir.ts';

describe('removeScratch with a fake git', () => {
  let dir: TempDir;
  let scratch: string;
  let tree: string;
  const record = (name: string): string => join(dir.path, '.git', 'worktrees', name);
  const calls: string[][] = [];
  // Answers rev-parse as git does from the checkout: the top level, then the common dir.
  const git: Git = async (_cwd, args) => {
    calls.push(args);
    const main = dir.path.replaceAll('\\', '/');
    return { ok: true, stdout: `${main}\n${main}/.git\n`, stderr: '' };
  };

  // The scratch tree of this review, the record of another review's tree, and a record whose
  // gitdir file is missing; only the first record belongs to this scratch folder.
  beforeEach(() => {
    calls.length = 0;
    dir = makeTempDir('scratch');
    scratch = join(dir.path, '.foedrum', 'tmp', '61', 'scratch');
    tree = join(scratch, 'tree');
    mkdirSync(join(scratch, 'mutants'), { recursive: true });
    mkdirSync(tree, { recursive: true });
    writeFileSync(join(tree, '.git'), `gitdir: ${record('tree')}\n`);
    mkdirSync(record('tree'), { recursive: true });
    writeFileSync(join(record('tree'), 'gitdir'), `${join(tree, '.git')}\n`);
    mkdirSync(record('tree1'), { recursive: true });
    writeFileSync(join(record('tree1'), 'gitdir'), `${join(dir.path, 'other', '.git')}\n`);
    mkdirSync(record('orphan'), { recursive: true });
  });
  afterEach(() => dir.remove());

  it('removes the scratch folder and its tree’s record, and leaves other records', async () => {
    const result = await removeScratch(dir.path, '.foedrum/tmp/61/scratch', git);

    assert.equal(result.ok, true, result.lines.join('\n'));
    assert.equal(existsSync(scratch), false);
    assert.equal(existsSync(record('tree')), false);
    assert.ok(existsSync(record('tree1')) && existsSync(record('orphan')));
    assert.deepEqual(calls, [
      ['rev-parse', '--path-format=absolute', '--show-toplevel', '--git-common-dir'],
    ]);
    assert.deepEqual(result.lines, [
      `removed ${scratch}`,
      'removed worktree record .git/worktrees/tree',
    ]);
  });

  it('removes the record its .git file names once git deleted that record’s gitdir file', async () => {
    rmSync(join(record('tree'), 'gitdir'));

    const result = await removeScratch(dir.path, '.foedrum/tmp/61/scratch', git);

    assert.equal(existsSync(record('tree')), false, result.lines.join('\n'));
    assert.ok(existsSync(record('orphan')));
    assert.ok(result.lines.includes('removed worktree record .git/worktrees/tree'));
  });

  it('refuses a folder outside .foedrum/tmp/ and removes nothing', async () => {
    const result = await removeScratch(dir.path, '.foedrum', git);

    assert.equal(result.ok, false);
    assert.ok(existsSync(scratch) && existsSync(record('tree')));
    assert.match(result.lines.join('\n'), /^refused: .* is not inside /);
  });

  it('removes nothing outside a git repository', async () => {
    const failing: Git = async () => ({ ok: false, stdout: '', stderr: 'fatal: not a git repo' });

    const result = await removeScratch(dir.path, '.foedrum/tmp/61/scratch', failing);

    assert.deepEqual(result, { ok: false, lines: ['refused: not inside a git repository'] });
    assert.ok(existsSync(scratch));
  });

  it('reports a removal that fails and still removes the record', async () => {
    const result = await removeScratch(dir.path, '.foedrum/tmp/61/scratch', git, async (path) => {
      if (path === scratch) throw Object.assign(new Error('EBUSY: simulated'), { code: 'EBUSY' });
    });

    assert.equal(result.ok, false);
    assert.deepEqual(result.lines, [
      `could not remove ${scratch}: EBUSY: simulated`,
      'removed worktree record .git/worktrees/tree',
    ]);
  });
});
