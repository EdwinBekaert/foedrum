// The files a proven step changed that declare a test at its tip (ADR 0262): read with git in
// the clone through an injected git (ADR 0021), at most a fixed number, each with its own deadline.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readTestFiles } from '../../src/checks/step-commits.ts';
import type { DiffFile } from '../../src/formats/unified-diff.ts';
import type { Git, GitOptions, GitResult } from '../../src/workspace/git.ts';

const tip = 'refs/heads/foedrum/12-1/gauge/1';
const clone = 'clone.git';

/** A file the step changed whose added lines declare no test: a table row. */
const row = (path: string): DiffFile => ({
  newPath: path,
  added: ["  ['adds negatives', -1, -2, -3],"],
  removed: [],
});

/** A git that answers cat-file from `tips` by path, and records each call with its options. */
const fakeGit = (tips: Record<string, GitResult>) => {
  const calls: { args: readonly string[]; options: GitOptions | undefined }[] = [];
  const git: Git = (_cwd, args, options) => {
    calls.push({ args, options });
    const path = (args.at(-1) ?? '').slice(tip.length + 1);
    return Promise.resolve(tips[path] ?? { code: 128, stdout: '', stderr: 'fatal: no path\n' });
  };
  return { git, calls };
};
const text = (stdout: string): GitResult => ({ code: 0, stdout, stderr: '' });

describe('readTestFiles (ADR 0262)', () => {
  it('reads at most 50 files, each within the diff limit and 10 s', async () => {
    const files = Array.from({ length: 51 }, (_, n) => row(`test/t${n}.test.mjs`));
    const { git, calls } = fakeGit({});
    await readTestFiles(git, clone, tip, files);
    assert.equal(calls.length, 50);
    assert.deepEqual(calls[0]?.args, ['cat-file', 'blob', `${tip}:test/t0.test.mjs`]);
    assert.equal(calls[0]?.options?.timeoutMs, 10_000);
    assert.equal(calls[0]?.options?.maxOutputBytes, 16 * 1024 * 1024);
  });

  it('throws when git was killed or timed out, rather than taking the file for no test file', async () => {
    const { git } = fakeGit({
      'test/sum.test.mjs': { code: null, stdout: '', stderr: '', killed: 'timed-out' },
    });
    await assert.rejects(
      readTestFiles(git, clone, tip, [row('test/sum.test.mjs')]),
      /git cat-file of test\/sum\.test\.mjs was killed/,
    );
  });
});
