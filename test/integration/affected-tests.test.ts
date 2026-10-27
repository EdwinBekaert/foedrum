// Real git for the affected tests' shell (ADR 0241): a repository with an origin/main, and a
// change made of a commit, an unstaged edit, a deleted file and an untracked one.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { affectedInCheckout } from '../../scripts/affected-tests.ts';
import { makeTempDir, type TempDir } from '../helpers/temp-dir.ts';

const git = (cwd: string, args: string[]): string =>
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=t@example.com', ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

const write = (root: string, files: Record<string, string>): void => {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
};

describe('affectedInCheckout with real git', () => {
  let dir: TempDir;
  let repo: string;
  before(() => {
    dir = makeTempDir('affected');
    repo = join(dir.path, 'repo');
    git(dir.path, ['init', '-q', '-b', 'main', repo]);
    write(repo, {
      'src/cli/deep/format.ts': 'export const format = 1;\n',
      'src/cli/status.ts':
        "import { format } from './deep/format.ts';\nexport const status = format;\n",
      'test/unit/cli/status.test.ts': "import { status } from '../../../src/cli/status.ts';\n",
      'src/schemas/order.ts': 'export const order = 1;\n',
      'test/unit/order.test.ts': "import { order } from '../../src/schemas/order.ts';\n",
      'src/gone.ts': 'export const gone = 1;\n',
      'test/unit/gone.test.ts': "import { gone } from '../../src/gone.ts';\n",
      'src/still.ts': 'export const still = 1;\n',
      'test/unit/still.test.ts': "import { still } from '../../src/still.ts';\n",
      'test/unit/untouched.test.ts': "import assert from 'node:assert/strict';\n",
    });
    git(repo, ['add', '.']);
    git(repo, ['commit', '-q', '-m', 'Base']);
    git(repo, ['update-ref', 'refs/remotes/origin/main', 'HEAD']);
    // Committed, unstaged, deleted and untracked.
    write(repo, { 'src/cli/deep/format.ts': 'export const format = 2;\n' });
    git(repo, ['commit', '-q', '-am', 'Change the format']);
    write(repo, {
      'src/schemas/order.ts': 'export const order = 2;\n',
      'test/unit/new.test.ts': "import assert from 'node:assert/strict';\n",
    });
    rmSync(join(repo, 'src', 'gone.ts'));
  });
  after(() => dir.remove());

  it('reaches the test files of every kind of change since the merge base, and no other', async () => {
    assert.deepEqual(await affectedInCheckout(repo), {
      kind: 'some',
      files: [
        'test/unit/cli/status.test.ts',
        'test/unit/gone.test.ts',
        'test/unit/new.test.ts',
        'test/unit/order.test.ts',
      ],
    });
  });

  it('runs every test file, saying why, without an origin/main', async () => {
    git(repo, ['update-ref', '-d', 'refs/remotes/origin/main']);
    const affected = await affectedInCheckout(repo);
    assert.equal(affected.kind, 'all');
    assert.match((affected as { why: string }).why, /^no merge base with origin\/main: /);
  });
});
