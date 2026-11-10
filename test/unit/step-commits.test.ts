// The files of a commit for the uncovered-line check (ADR 0274), the shell, on a fake git
// (ADR 0021) that answers with git's own output, captured once from a real `ls-tree -z`.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFilesAt } from '../../src/checks/step-commits.ts';
import type { Git, GitResult } from '../../src/workspace/git.ts';

const TIP = 'e'.repeat(40);
const clone = '/work/acme.app/clone';

/** git 2.56's `ls-tree -r -z --name-only` of a commit of README.md, legacy/old.ts and legacy/deep/a b.ts. */
const LS_TREE = 'README.md\0legacy/deep/a b.ts\0legacy/old.ts\0';

const answering = (result: GitResult) => {
  const calls: { cwd: string; args: readonly string[] }[] = [];
  const git: Git = async (cwd, args) => {
    calls.push({ cwd, args });
    return result;
  };
  return { git, calls };
};

describe('readFilesAt (ADR 0274)', () => {
  it('lists every file of a commit, those in folders by their whole path: regression test', async () => {
    const { git, calls } = answering({ code: 0, stdout: LS_TREE, stderr: '' });
    assert.deepEqual(await readFilesAt(git, clone, TIP), {
      files: ['README.md', 'legacy/deep/a b.ts', 'legacy/old.ts'],
    });
    assert.deepEqual(calls, [
      { cwd: clone, args: ['ls-tree', '-r', '-z', '--name-only', TIP, '--'] },
    ]);
  });

  it("fails with git's last line when ls-tree does (regression test)", async () => {
    const { git } = answering({
      code: 128,
      stdout: '',
      stderr: `error: object ${TIP} not found\nfatal: not a tree object\n`,
    });
    assert.deepEqual(await readFilesAt(git, clone, TIP), { error: 'fatal: not a tree object' });
  });
});
