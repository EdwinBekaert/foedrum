// The pushes of the openPullRequest action (ADR 0071), the shell, with a fake git that records
// every call (ADR 0021): git runs in the clone, never by force, and nothing from outside reaches
// it as an option.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { openBranchPush } from '../../src/workspace/branch-push-git.ts';
import type { Git, GitOptions, GitResult } from '../../src/workspace/git.ts';

const TIP = 'c'.repeat(40);
const branch = 'foedrum/acme.brewery/12-1/acme.api';
const clone = '/work/acme.api/clone';

const ok = (stdout = ''): GitResult => ({ code: 0, stdout, stderr: '' });
const failed = (stderr: string): GitResult => ({ code: 1, stdout: '', stderr });

/** A git that answers each call through `answer` and records it with its options. */
const recordingGit = (answer: (args: readonly string[]) => GitResult = () => ok()) => {
  const calls: { cwd: string; args: readonly string[]; options: GitOptions | undefined }[] = [];
  const git: Git = async (cwd, args, options) => {
    calls.push({ cwd, args, options });
    return answer(args);
  };
  return { git, calls };
};

describe('openBranchPush: commit', () => {
  it('resolves the revision to a commit in the clone, never as an option', async () => {
    const { git, calls } = recordingGit(() => ok(`${TIP}\n`));
    const push = openBranchPush({ git, clone });
    assert.equal(await push.commit('refs/heads/foedrum/12-1/implement/1'), TIP);
    assert.deepEqual(
      calls.map(({ cwd, args }) => [cwd, ...args]),
      [
        [
          clone,
          'rev-parse',
          '--verify',
          '--quiet',
          '--end-of-options',
          'refs/heads/foedrum/12-1/implement/1^{commit}',
        ],
      ],
    );
  });

  it('fails when the revision names no commit', async () => {
    for (const result of [failed(''), ok('not a sha\n')]) {
      const push = openBranchPush({ git: recordingGit(() => result).git, clone });
      await assert.rejects(push.commit('refs/heads/gone'), {
        message: `The revision refs/heads/gone is no commit in ${clone}`,
      });
    }
  });
});

describe('openBranchPush: remoteTip', () => {
  it("reads the remote branch's commit with ls-remote, matching the ref exactly", async () => {
    const listed = [
      `${'e'.repeat(40)}\trefs/heads/${branch}-old`,
      `${TIP}\trefs/heads/${branch}`,
      '',
    ].join('\n');
    const { git, calls } = recordingGit(() => ok(listed));
    const push = openBranchPush({ git, clone, remote: 'upstream' });
    assert.equal(await push.remoteTip(branch), TIP);
    assert.deepEqual(
      calls.map(({ cwd, args }) => [cwd, ...args]),
      [[clone, 'ls-remote', '--refs', 'upstream', `refs/heads/${branch}`]],
    );
  });

  it('is undefined when the remote has no such branch, and fails when git does', async () => {
    const none = openBranchPush({ git: recordingGit(() => ok('')).git, clone });
    assert.equal(await none.remoteTip(branch), undefined);
    const down = openBranchPush({
      git: recordingGit(() => failed('fatal: could not read from remote repository\n')).git,
      clone,
    });
    await assert.rejects(down.remoteTip(branch), {
      message: 'git ls-remote failed: fatal: could not read from remote repository',
    });
  });
});

describe('openBranchPush: push', () => {
  it("pushes the commit to the remote's branch without force and without the user's hooks", async () => {
    const { git, calls } = recordingGit();
    const push = openBranchPush({ git, clone });
    await push.push(TIP, branch);
    assert.deepEqual(
      calls.map(({ cwd, args }) => [cwd, ...args]),
      [[clone, 'push', '--no-verify', 'origin', `${TIP}:refs/heads/${branch}`]],
    );
  });

  it("fails with git's reason, as a push the remote rejected", async () => {
    const rejected = failed(
      ' ! [rejected]        cccc -> foedrum/x (non-fast-forward)\nerror: failed\n',
    );
    const push = openBranchPush({ git: recordingGit(() => rejected).git, clone });
    await assert.rejects(push.push(TIP, branch), {
      message: 'git push failed: ! [rejected]        cccc -> foedrum/x (non-fast-forward)',
    });
  });

  it('refuses a commit that is no full sha, and a branch outside foedrum/, before git runs', async () => {
    const { git, calls } = recordingGit();
    const push = openBranchPush({ git, clone });
    await assert.rejects(push.push('HEAD', branch), /HEAD is no full commit sha/);
    await assert.rejects(push.push(TIP, '--force'), /"--force" is no branch in foedrum\//);
    await assert.rejects(push.remoteTip('main'), /"main" is no branch in foedrum\//);
    assert.deepEqual(calls, []);
  });
});

describe('openBranchPush: signals and time', () => {
  it('passes the signal to every git call, with time for a large push', async () => {
    const { git, calls } = recordingGit((args) =>
      args[0] === 'rev-parse' ? ok(`${TIP}\n`) : ok(''),
    );
    const push = openBranchPush({ git, clone });
    const { signal } = new AbortController();
    await push.commit('refs/heads/x', signal);
    await push.remoteTip(branch, signal);
    await push.push(TIP, branch, signal);
    assert.deepEqual(
      calls.map(({ options }) => options?.signal === signal),
      [true, true, true],
    );
    assert.equal(calls[2]?.options?.timeoutMs, 300_000);
  });
});
