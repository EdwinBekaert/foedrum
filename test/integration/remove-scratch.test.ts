// Real git for the brew-review scratch cleanup (issue #61): a scratch tree whose record under
// .git/worktrees/ is read-only, as Windows leaves it, next to another review's tree.

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { removeTree } from '../../src/platform/remove.ts';
import { makeTempDir, type TempDir } from '../helpers/temp-dir.ts';
import { makeReadOnly } from './read-only.ts';

const script = join(import.meta.dirname, '..', '..', 'scripts', 'remove-scratch.ts');

const git = (cwd: string, args: string[]): string =>
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=t@example.com', ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

describe('remove-scratch with real git', () => {
  let dir: TempDir;
  let main: string;
  beforeEach(() => {
    dir = makeTempDir('scratch');
    main = join(dir.path, 'main');
    git(dir.path, ['init', '-q', '-b', 'main', main]);
    writeFileSync(join(main, '.gitignore'), '.foedrum/\n');
    git(main, ['add', '.gitignore']);
    git(main, ['commit', '-q', '-m', 'Initial commit']);
  });
  afterEach(() => removeTree(dir.path));

  it('removes the scratch tree and its read-only record, and keeps the other record', () => {
    const tree = join(main, '.foedrum', 'tmp', '61', 'scratch', 'tree');
    const other = join(main, '.foedrum', 'tmp', '58', 'scratch', 'tree');
    git(main, ['worktree', 'add', '-q', '--detach', tree, 'HEAD']);
    git(main, ['worktree', 'add', '-q', '--detach', other, 'HEAD']);
    const records = join(main, '.git', 'worktrees');
    const own = basename(
      readFileSync(join(tree, '.git'), 'utf8')
        .replace(/^gitdir:/, '')
        .trim(),
    );
    makeReadOnly(join(records, own));

    const result = spawnSync(process.execPath, [script, '.foedrum/tmp/61/scratch'], {
      cwd: main,
      encoding: 'utf8',
    });

    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
    assert.equal(existsSync(join(main, '.foedrum', 'tmp', '61', 'scratch')), false);
    assert.equal(existsSync(join(records, own)), false, result.stdout);
    assert.equal(readdirSync(records).length, 1);
    const listed = git(main, ['worktree', 'list', '--porcelain']);
    assert.equal(listed.split('\n').filter((line) => line.startsWith('worktree ')).length, 2);
    assert.match(result.stdout, new RegExp(`removed worktree record \\.git/worktrees/${own}`));

    const refused = spawnSync(process.execPath, [script, '.'], { cwd: main, encoding: 'utf8' });
    assert.equal(refused.status, 1, refused.stdout);
    assert.match(refused.stdout, /refused: .* is not inside /);
    assert.ok(existsSync(join(main, '.gitignore')));
  });
});
