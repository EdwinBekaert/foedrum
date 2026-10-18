// The commits an attempt made (ADR 0074), the shell, with a fake git that records every call
// (ADR 0021): it asks in the clone, on the attempt's branch, from the start commit as a full sha,
// so nothing the brewer wrote in its worktree decides the answer, and git's failure is an answer,
// never a throw.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { countCommits } from '../../src/workspace/attempt-commits-git.ts';
import { attemptBranch } from '../../src/workspace/attempt-worktrees.ts';
import type { Git, GitOptions, GitResult } from '../../src/workspace/git.ts';

const START = 'c'.repeat(40);
const clone = '/work/acme.api/clone.git';
const branch = 'foedrum/12-1/brew/1';

const ok = (stdout = ''): GitResult => ({ code: 0, stdout, stderr: '' });
const exited = (code: number | null, stderr = ''): GitResult => ({ code, stdout: '', stderr });

/** A git that answers each call by its subcommand and records it with its options. */
const recordingGit = (answers: Record<string, GitResult>) => {
  const calls: { cwd: string; args: readonly string[]; options: GitOptions | undefined }[] = [];
  const git: Git = async (cwd, args, options) => {
    calls.push({ cwd, args, options });
    return answers[args[0] ?? ''] ?? exited(2, 'unexpected call');
  };
  return { git, calls };
};

describe('countCommits', () => {
  it("asks in the clone whether the start is an ancestor of the attempt's branch, then counts the commits after it", async () => {
    const { git, calls } = recordingGit({ 'merge-base': ok(), 'rev-list': ok('3\n') });
    const signal = new AbortController().signal;
    assert.deepEqual(await countCommits(git)(clone, branch, START, signal), {
      kind: 'counted',
      count: 3,
    });
    assert.deepEqual(
      calls.map(({ cwd, args }) => [cwd, ...args]),
      [
        [clone, 'merge-base', '--is-ancestor', START, `refs/heads/${branch}`],
        [clone, 'rev-list', '--count', `${START}..refs/heads/${branch}`],
      ],
    );
    assert.ok(calls.every(({ options }) => options?.signal === signal));
  });

  it('counts none when the branch is at the start', async () => {
    const { git } = recordingGit({ 'merge-base': ok(), 'rev-list': ok('0\n') });
    assert.deepEqual(await countCommits(git)(clone, branch, START), { kind: 'counted', count: 0 });
  });

  it('counts from a SHA-256 start, which a commit sha may be (review of #208)', async () => {
    const start = 'd'.repeat(64);
    const { git, calls } = recordingGit({ 'merge-base': ok(), 'rev-list': ok('1\n') });
    assert.deepEqual(await countCommits(git)(clone, branch, start), { kind: 'counted', count: 1 });
    assert.equal(calls[0]?.args[2], start);
  });

  it('says the start was rewritten when it is no ancestor of the branch, and counts nothing', async () => {
    const { git, calls } = recordingGit({ 'merge-base': exited(1) });
    assert.deepEqual(await countCommits(git)(clone, branch, START), { kind: 'rewritten' });
    assert.equal(calls.length, 1);
  });

  it("gives git's first line when either call fails", async () => {
    const failing = recordingGit({ 'merge-base': exited(128, '\nfatal: not a git repository\n') });
    assert.deepEqual(await countCommits(failing.git)(clone, branch, START), {
      kind: 'uncounted',
      reason: 'git merge-base failed: fatal: not a git repository',
    });
    const silent = recordingGit({ 'merge-base': exited(128) });
    assert.deepEqual(await countCommits(silent.git)(clone, branch, START), {
      kind: 'uncounted',
      reason: 'git merge-base failed: git exited with 128',
    });
    const killed = recordingGit({ 'merge-base': ok(), 'rev-list': exited(null) });
    assert.deepEqual(await countCommits(killed.git)(clone, branch, START), {
      kind: 'uncounted',
      reason: 'git rev-list failed: git did not finish in time',
    });
  });

  it('does not read a count that is no number', async () => {
    const { git } = recordingGit({ 'merge-base': ok(), 'rev-list': ok('three\n') });
    assert.deepEqual(await countCommits(git)(clone, branch, START), {
      kind: 'uncounted',
      reason: 'git rev-list gave no count: "three"',
    });
  });

  it('runs no git for a start that is no full commit sha, so nothing reaches git as an option', async () => {
    const { git, calls } = recordingGit({});
    for (const since of ['--output=x', 'HEAD~1', 'c'.repeat(39), 'c'.repeat(41)]) {
      assert.deepEqual(await countCommits(git)(clone, branch, since), {
        kind: 'uncounted',
        reason: `${since} is no full commit sha`,
      });
    }
    assert.deepEqual(calls, []);
  });

  it('counts on every branch attemptBranch makes, a target batch and a step id with a dot among them (review of #208)', async () => {
    const other = attemptBranch({ batchId: 'web-12-2', stepId: 'red.proof', attempt: 3 });
    const { git, calls } = recordingGit({ 'merge-base': ok(), 'rev-list': ok('1\n') });
    assert.deepEqual(await countCommits(git)(clone, other, START), { kind: 'counted', count: 1 });
    assert.equal(calls[0]?.args[3], `refs/heads/${other}`);
  });

  it('runs no git for a branch that is no attempt branch', async () => {
    const { git, calls } = recordingGit({});
    for (const other of ['main', '--all', 'foedrum/../main', 'foedrum/12-1/brew/1 x']) {
      assert.deepEqual(await countCommits(git)(clone, other, START), {
        kind: 'uncounted',
        reason: `${JSON.stringify(other)} is no attempt branch`,
      });
    }
    assert.deepEqual(calls, []);
  });
});
