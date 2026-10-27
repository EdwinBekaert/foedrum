// The paths of a plan read at a commit with real git (ADR 0233, ADR 0021): in a blob-less bare
// clone whose origin is gone, so a read that fetched a blob would fail. The check around it is a
// unit test in test/unit/plan-touches.test.ts.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { pathToFileURL } from 'node:url';
import { removeTree } from '../../src/platform/remove.ts';
import { runGit } from '../../src/workspace/git.ts';
import { readPathsAt } from '../../src/workspace/plan-paths-git.ts';
import { makeTempDir, type TempDir } from '../helpers/temp-dir.ts';

const git = (cwd: string, args: string[]): string =>
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=t@example.com', ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();

describe('readPathsAt (ADR 0233)', () => {
  let dir: TempDir;
  let clone: string;
  let commit: string;
  before(async () => {
    dir = makeTempDir('plan-paths');
    const origin = join(dir.path, 'origin');
    git(dir.path, ['init', '-q', '-b', 'main', origin]);
    mkdirSync(join(origin, 'src', 'deep'), { recursive: true });
    writeFileSync(join(origin, 'src', 'deep', 'a.ts'), 'export {};\n');
    writeFileSync(join(origin, '[x].md'), '# x\n');
    git(origin, ['add', '.']);
    git(origin, ['commit', '-q', '-m', 'Initial commit']);
    git(origin, ['config', 'uploadpack.allowFilter', 'true']);
    clone = join(dir.path, 'clone.git');
    git(dir.path, [
      'clone',
      '-q',
      '--bare',
      '--filter=blob:none',
      pathToFileURL(origin).href,
      clone,
    ]);
    commit = git(clone, ['rev-parse', 'HEAD']);
    await removeTree(origin);
  });
  after(() => dir.remove());

  it('finds files and folders at the commit, by their literal names, with no blob fetched', async () => {
    const read = await readPathsAt(runGit)(clone, commit, [
      'src/deep/a.ts',
      'src',
      'src/deep',
      '[x].md',
      'x.md',
      'src/gone.ts',
    ]);
    assert.deepEqual(read.kind === 'read' ? [...read.present].sort() : read, [
      '[x].md',
      'src',
      'src/deep',
      'src/deep/a.ts',
    ]);
  });

  it('is unread for a commit that is not in the clone, or no full sha', async () => {
    const missing = await readPathsAt(runGit)(clone, 'e'.repeat(40), ['src']);
    assert.equal(missing.kind, 'unread');
    const option = await readPathsAt(runGit)(clone, '--output=x', ['src']);
    assert.deepEqual(option, { kind: 'unread', reason: '--output=x is no full commit sha' });
  });
});
