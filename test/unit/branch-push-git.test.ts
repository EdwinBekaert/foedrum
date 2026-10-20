// The pushes of the openPullRequest action (ADR 0071), the shell, with a fake git that records
// every call (ADR 0021): git runs in the clone, never by force, and nothing from outside reaches
// it as an option.

import assert from 'node:assert/strict';
import { devNull } from 'node:os';
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

describe('openBranchPush: isAncestor (review of #198)', () => {
  it('asks merge-base in the clone, and reads its exit code', async () => {
    const other = 'd'.repeat(40);
    const yes = recordingGit(() => ok());
    assert.equal(await openBranchPush({ git: yes.git, clone }).isAncestor(TIP, other), true);
    assert.deepEqual(
      yes.calls.map(({ cwd, args }) => [cwd, ...args]),
      [[clone, 'merge-base', '--is-ancestor', TIP, other]],
    );
    const no = openBranchPush({ git: recordingGit(() => failed('')).git, clone });
    assert.equal(await no.isAncestor(TIP, other), false);
  });

  it('fails when git does, and refuses a commit that is no full sha before git runs', async () => {
    const broken = recordingGit(() => ({
      code: 128,
      stdout: '',
      stderr: 'fatal: Not a valid commit name\n',
    }));
    await assert.rejects(openBranchPush({ git: broken.git, clone }).isAncestor(TIP, TIP), {
      message: 'git merge-base failed: fatal: Not a valid commit name',
    });
    const { git, calls } = recordingGit();
    await assert.rejects(
      openBranchPush({ git, clone }).isAncestor('HEAD', TIP),
      /HEAD is no full commit sha/,
    );
    await assert.rejects(
      openBranchPush({ git, clone }).isAncestor(TIP, 'HEAD'),
      /HEAD is no full commit sha/,
    );
    assert.deepEqual(calls, []);
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

  it("runs none of the clone's hooks, which a brewer's code can write (review of #198)", async () => {
    const { git, calls } = recordingGit();
    await openBranchPush({ git, clone }).push(TIP, branch);
    assert.deepEqual(calls[0]?.options?.config, { 'core.hooksPath': devNull });
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

describe('openBranchPush: secretScan (ADR 0079)', () => {
  const BASE = 'b'.repeat(40);
  // Built at run time, so no scanner takes this file for one that holds a token.
  const token = ['ghp', 'A1b2'.repeat(9)].join('_');
  const known = 'a'.repeat(40);
  const messages = `\0${TIP}\nUse the key\n\nGH=${token}\nRevert ${known}\n`;
  const patches = [
    `\0${TIP}`,
    '',
    'diff --git a/keys.txt b/keys.txt',
    'new file mode 100644',
    '--- /dev/null',
    '+++ b/keys.txt',
    '@@ -0,0 +1 @@',
    `+${token}`,
  ].join('\n');
  const headers = [
    `commit ${TIP}`,
    `tree ${'f'.repeat(40)}`,
    `author ${token} <brewer@example.com> 1792484716 +0200`,
    'committer Brewer <brewer@example.com> 1792484716 +0200',
    '',
    '    Use the key',
    '',
  ].join('\n');
  const answers = (args: readonly string[]): GitResult => {
    if (args.includes('--patch')) return ok(patches);
    if (args.includes('--format=raw')) return ok(headers);
    if (args[0] === 'log') return ok(messages);
    if (args[0] === 'cat-file') return ok(`${known} commit\n`);
    return failed('unexpected');
  };
  const range = ['--end-of-options', TIP, `^${BASE}`];

  it('reads the messages and the added lines of every commit from the base, in the clone', async () => {
    const { git, calls } = recordingGit(answers);
    const found = await openBranchPush({ git, clone }).secretScan(BASE, TIP);
    assert.deepEqual(found, [
      { commit: TIP, place: 'message', kind: 'GitHub token' },
      { commit: TIP, place: 'author', kind: 'GitHub token' },
      { commit: TIP, place: 'keys.txt', kind: 'GitHub token' },
    ]);
    assert.deepEqual(
      calls.map(({ cwd, args }) => [cwd, ...args]),
      [
        [
          clone,
          'log',
          '--no-notes',
          '--no-show-signature',
          '--encoding=UTF-8',
          '--format=%x00%H%n%B',
          ...range,
        ],
        // Every header as stored: the author, the committer, a signature, an encoding (review of #237).
        [
          clone,
          'log',
          '--no-notes',
          '--no-show-signature',
          '--no-decorate',
          '--no-mailmap',
          '--format=raw',
          ...range,
        ],
        [
          clone,
          'log',
          '--no-notes',
          '--no-show-signature',
          '--format=%x00%H',
          '--patch',
          '--diff-merges=first-parent',
          '--unified=0',
          '--inter-hunk-context=0',
          '--no-ext-diff',
          '--no-textconv',
          '--no-color',
          '--no-renames',
          '--no-relative',
          '--ignore-submodules=none',
          '--submodule=short',
          '--src-prefix=a/',
          '--dst-prefix=b/',
          ...range,
        ],
        // Only the hexadecimal words, asked of the clone's objects as committed.
        [clone, 'cat-file', '--batch-check=%(objectname) %(objecttype)'],
      ],
    );
    assert.equal(calls[3]?.options?.stdin, `${known}\n`);
  });

  it('reads history as committed: no replace ref, graft or shallow file, attribute file or log setting of the clone changes it', async () => {
    const { git, calls } = recordingGit(answers);
    await openBranchPush({ git, clone }).secretScan(BASE, TIP);
    for (const { options } of calls) {
      assert.deepEqual(options?.env, {
        GIT_NO_REPLACE_OBJECTS: '1',
        GIT_GRAFT_FILE: devNull,
        GIT_SHALLOW_FILE: devNull,
        // A partial clone would fetch a missing object, so a key asked of cat-file would leave.
        GIT_NO_LAZY_FETCH: '1',
      });
      assert.deepEqual(options?.config, {
        'core.attributesFile': devNull,
        'log.showRoot': 'true',
        'advice.graftFileDeprecated': 'false',
        // No transport at all, whatever the git version: a lazy fetch fails here instead.
        'protocol.allow': 'never',
      });
    }
  });

  it('keeps a hexadecimal word the clone has as no commit: git answers missing, or another type', async () => {
    const key = 'd'.repeat(40);
    const blob = 'e'.repeat(40);
    const { git } = recordingGit((args) =>
      args[0] === 'log'
        ? ok(args.includes('--patch') ? '' : `\0${TIP}\nUse ${key}\nand ${blob}\n`)
        : ok(`${key} missing\n${blob} blob\n`),
    );
    assert.deepEqual(await openBranchPush({ git, clone }).secretScan(BASE, TIP), [
      { commit: TIP, place: 'message', kind: 'long hexadecimal string' },
    ]);
  });

  it('asks nothing of the objects when no word may be a commit', async () => {
    const { git, calls } = recordingGit((args) =>
      args[0] === 'log' ? ok(`\0${TIP}\nClean\n`) : failed('unexpected'),
    );
    assert.deepEqual(await openBranchPush({ git, clone }).secretScan(BASE, TIP), []);
    assert.deepEqual(
      calls.map(({ args }) => args[0]),
      ['log', 'log', 'log'],
    );
  });

  it('refuses commits it cannot read whole: more than 4 MiB of messages or changes', async () => {
    for (const large of ['messages', 'patches']) {
      const { git } = recordingGit((args) => {
        const killed = args.includes('--patch') === (large === 'patches');
        return killed && args[0] === 'log'
          ? {
              code: null,
              stdout: 'diff',
              stderr: 'git wrote more than 4 MiB of output',
              killed: 'too-much-output',
            }
          : ok(`\0${TIP}\nClean\n`);
      });
      assert.deepEqual(await openBranchPush({ git, clone }).secretScan(BASE, TIP), [
        {
          commit: TIP,
          place: `the commits from ${BASE}`,
          kind: 'more than 4 MiB of messages or changes, past what the scan reads',
        },
      ]);
    }
  });

  it('refuses commits whose headers alone pass 4 MiB', async () => {
    const { git } = recordingGit((args) =>
      args.includes('--format=raw')
        ? { code: null, stdout: 'commit', stderr: '', killed: 'too-much-output' }
        : ok(args.includes('--patch') ? '' : `\0${TIP}\nClean\n`),
    );
    assert.deepEqual(await openBranchPush({ git, clone }).secretScan(BASE, TIP), [
      {
        commit: TIP,
        place: `the commits from ${BASE}`,
        kind: 'more than 4 MiB of messages or changes, past what the scan reads',
      },
    ]);
  });

  it("fails with git's reason when git does, and refuses a commit that is no full sha before git runs", async () => {
    const broken = recordingGit(() => ({ code: 128, stdout: '', stderr: 'fatal: bad object\n' }));
    await assert.rejects(openBranchPush({ git: broken.git, clone }).secretScan(BASE, TIP), {
      message: 'git log failed: fatal: bad object',
    });
    const { git, calls } = recordingGit();
    await assert.rejects(
      openBranchPush({ git, clone }).secretScan('main', TIP),
      /main is no full commit sha/,
    );
    await assert.rejects(
      openBranchPush({ git, clone }).secretScan(BASE, 'HEAD'),
      /HEAD is no full commit sha/,
    );
    assert.deepEqual(calls, []);
  });

  it('passes the signal to every git call', async () => {
    const { git, calls } = recordingGit(answers);
    const { signal } = new AbortController();
    await openBranchPush({ git, clone }).secretScan(BASE, TIP, signal);
    assert.deepEqual(
      calls.map(({ options }) => options?.signal === signal),
      [true, true, true, true],
    );
  });
});
