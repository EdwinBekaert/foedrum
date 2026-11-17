// The files a Taster's findings cite, read at the commit it reviewed with real git (ADR 0421, ADR
// 0021): in a bare clone, at a commit a later one changed. The check around it is a unit test in
// test/unit/finding-places.test.ts.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { pathToFileURL } from 'node:url';
import { readFilesAt } from '../../src/workspace/finding-files-git.ts';
import { runGit } from '../../src/workspace/git.ts';
import { makeTempDir, type TempDir } from '../helpers/temp-dir.ts';

const git = (cwd: string, args: string[]): string =>
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=t@example.com', ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();

describe('readFilesAt (ADR 0421)', () => {
  let dir: TempDir;
  let clone: string;
  let reviewed: string;
  before(() => {
    dir = makeTempDir('finding-files');
    const origin = join(dir.path, 'origin');
    git(dir.path, ['init', '-q', '-b', 'main', origin]);
    mkdirSync(join(origin, 'src'), { recursive: true });
    writeFileSync(join(origin, 'src', 'a.ts'), 'one\ntwo\n');
    writeFileSync(join(origin, '[x].md'), '# x\n');
    git(origin, ['add', '.']);
    git(origin, ['commit', '-q', '-m', 'Initial commit']);
    reviewed = git(origin, ['rev-parse', 'HEAD']);
    writeFileSync(join(origin, 'src', 'a.ts'), 'one\ntwo\nthree\n');
    git(origin, ['commit', '-q', '-am', 'Add a line']);
    clone = join(dir.path, 'clone.git');
    git(dir.path, ['clone', '-q', '--bare', pathToFileURL(origin).href, clone]);
  });
  after(() => dir.remove());

  it('reads each file as it was at the reviewed commit, by its literal name, and no text for a folder or a missing path', async () => {
    const read = await readFilesAt(runGit)(clone, reviewed, ['src/a.ts', '[x].md', 'src', 'x.md']);
    assert.deepEqual(read, {
      kind: 'read',
      files: new Map([
        ['src/a.ts', 'one\ntwo\n'],
        ['[x].md', '# x\n'],
        ['src', undefined],
        ['x.md', undefined],
      ]),
    });
  });

  it('gives no text for a path in another letter case, on every file system, since the tree is case-sensitive', async () => {
    const read = await readFilesAt(runGit)(clone, reviewed, ['SRC/a.ts', 'src/A.ts']);
    assert.deepEqual(read, {
      kind: 'read',
      files: new Map([
        ['SRC/a.ts', undefined],
        ['src/A.ts', undefined],
      ]),
    });
  });
});
