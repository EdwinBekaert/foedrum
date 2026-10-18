// The commits an attempt made (ADR 0074), the shell, with a fake git that records every call
// (ADR 0021): it asks in the worktree, from the start commit as a full sha, and git's failure is an
// answer, never a throw.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { countCommits } from '../../src/workspace/attempt-commits-git.ts';
import type { Git, GitOptions, GitResult } from '../../src/workspace/git.ts';

const START = 'c'.repeat(40);
const worktree = '/work/acme.api/attempts/12-1/brew/1';

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
  it('asks whether the start is an ancestor of HEAD, then counts the commits after it', async () => {
    const { git, calls } = recordingGit({ 'merge-base': ok(), 'rev-list': ok('3\n') });
    const signal = new AbortController().signal;
    assert.deepEqual(await countCommits(git)(worktree, START, signal), {
      kind: 'counted',
      count: 3,
    });
    assert.deepEqual(
      calls.map(({ cwd, args }) => [cwd, ...args]),
      [
        [worktree, 'merge-base', '--is-ancestor', START, 'HEAD'],
        [worktree, 'rev-list', '--count', `${START}..HEAD`],
      ],
    );
    assert.ok(calls.every(({ options }) => options?.signal === signal));
  });

  it('counts none when HEAD is the start', async () => {
    const { git } = recordingGit({ 'merge-base': ok(), 'rev-list': ok('0\n') });
    assert.deepEqual(await countCommits(git)(worktree, START), { kind: 'counted', count: 0 });
  });

  it('says the start was rewritten when it is no ancestor of HEAD, and counts nothing', async () => {
    const { git, calls } = recordingGit({ 'merge-base': exited(1) });
    assert.deepEqual(await countCommits(git)(worktree, START), { kind: 'rewritten' });
    assert.equal(calls.length, 1);
  });

  it("gives git's first line when either call fails", async () => {
    const failing = recordingGit({ 'merge-base': exited(128, '\nfatal: not a git repository\n') });
    assert.deepEqual(await countCommits(failing.git)(worktree, START), {
      kind: 'uncounted',
      reason: 'git merge-base failed: fatal: not a git repository',
    });
    const killed = recordingGit({ 'merge-base': ok(), 'rev-list': exited(null) });
    assert.deepEqual(await countCommits(killed.git)(worktree, START), {
      kind: 'uncounted',
      reason: 'git rev-list failed: git did not finish in time',
    });
  });

  it('does not read a count that is no number', async () => {
    const { git } = recordingGit({ 'merge-base': ok(), 'rev-list': ok('three\n') });
    assert.deepEqual(await countCommits(git)(worktree, START), {
      kind: 'uncounted',
      reason: 'git rev-list gave no count: "three"',
    });
  });

  it('runs no git for a start that is no full commit sha, so nothing reaches git as an option', async () => {
    const { git, calls } = recordingGit({});
    for (const since of ['--output=x', 'HEAD~1', 'c'.repeat(39)]) {
      assert.deepEqual(await countCommits(git)(worktree, since), {
        kind: 'uncounted',
        reason: `${since} is no full commit sha`,
      });
    }
    assert.deepEqual(calls, []);
  });
});
