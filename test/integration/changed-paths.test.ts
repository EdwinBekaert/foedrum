// The paths an attempt's commits changed, for the checks before a brewer's end (ADR 0381), with real
// git: a clone whose attempt branch adds, renames, changes and deletes files after the attempt's
// start. Nothing reaches the network.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { removeTree } from '../../src/platform/remove.ts';
import { changedPaths } from '../../src/workspace/attempt-commits-git.ts';
import { runGit } from '../../src/workspace/git.ts';
import { makeTempDir, type TempDir } from '../helpers/temp-dir.ts';

const git = (cwd: string, args: string[]): string =>
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=t@example.com', ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

const branch = 'foedrum/21-1/implement/1';

describe('changedPaths with real git', () => {
  let dir: TempDir;
  before(() => {
    dir = makeTempDir('changed-paths');
  });
  after(async () => {
    await removeTree(dir.path);
  });

  it('lists the paths the commits after the start added, changed or renamed to, never a deleted one', async () => {
    const clone = join(dir.path, 'clone');
    execFileSync('git', ['init', '-q', '-b', 'main', clone]);
    mkdirSync(join(clone, 'src'));
    for (const name of ['kept.ts', 'changed.ts', 'gone.ts', 'old name.ts']) {
      writeFileSync(join(clone, 'src', name), `export const ${name.length} = 1;\n`);
    }
    git(clone, ['add', '.']);
    git(clone, ['commit', '-q', '-m', 'Start']);
    const start = git(clone, ['rev-parse', 'HEAD']).trim();
    git(clone, ['switch', '-q', '-c', branch]);
    writeFileSync(join(clone, 'src', 'changed.ts'), 'export const changed = 2;\n');
    writeFileSync(join(clone, 'src', 'a new file.ts'), 'export const added = 1;\n');
    git(clone, ['rm', '-q', 'src/gone.ts']);
    git(clone, ['mv', 'src/old name.ts', 'src/new name.ts']);
    git(clone, ['add', '.']);
    git(clone, ['commit', '-q', '-m', 'The attempt']);
    const listed = await changedPaths(runGit)(clone, branch, start);
    assert.equal(listed.kind, 'listed', JSON.stringify(listed));
    assert.deepEqual(listed.kind === 'listed' ? [...listed.paths].sort() : [], [
      'src/a new file.ts',
      'src/changed.ts',
      'src/new name.ts',
    ]);
  });
});
