// The pushes of the openPullRequest action (ADR 0071), the shell, with a fake git that records
// every call (ADR 0021): git reads and pushes in the clone (ADR 0137), fetches the base from a git
// directory of its own (ADR 0090), never by force, and nothing from outside reaches it as an option.

import assert from 'node:assert/strict';
import { existsSync, mkdirSync } from 'node:fs';
import { devNull } from 'node:os';
import { dirname, join } from 'node:path';
import { beforeEach, describe, it } from 'node:test';
import { listRemoteRefs, openBranchPush } from '../../src/workspace/branch-push-git.ts';
import type { Git, GitOptions, GitResult } from '../../src/workspace/git.ts';
import { suiteFolders } from '../helpers/attempt-worktrees.ts';

const TIP = 'c'.repeat(40);
const branch = 'foedrum/acme.brewery/12-1/acme.api';
const clone = '/work/acme.api/clone';

const ok = (stdout = ''): GitResult => ({ code: 0, stdout, stderr: '' });
const failed = (stderr: string): GitResult => ({ code: 1, stdout: '', stderr });

/**
 * A git that answers each call through `answer` and records it with its options; its init makes
 * the git directory it names, as git would.
 */
const recordingGit = (answer: (args: readonly string[]) => GitResult = () => ok()) => {
  const calls: { cwd: string; args: readonly string[]; options: GitOptions | undefined }[] = [];
  const git: Git = async (cwd, args, options) => {
    calls.push({ cwd, args, options });
    if (args[1] === 'init' && args[0]?.startsWith('--git-dir=')) {
      mkdirSync(args[0].slice('--git-dir='.length), { recursive: true });
    }
    return answer(args);
  };
  return { git, calls };
};

/** What every git call in the clone runs with: no hook or fsmonitor (ADR 0137). */
const IN_CLONE = { 'core.hooksPath': devNull, 'core.fsmonitor': 'false' };
/** What every call in Foedrum's own git directory runs with: no hook, gc or maintenance. */
const OWN_CONFIG = {
  'core.hooksPath': devNull,
  'gc.auto': '0',
  'maintenance.auto': 'false',
};
const url = 'https://github.com/acme/api.git';
const nextFolder = suiteFolders('branch-push-git');
/** rev-parse's answer for the clone's git directory and object format. */
const named = (args: readonly string[]): GitResult | undefined =>
  args.includes('--show-object-format') ? ok(`${clone}\nsha1\n`) : undefined;

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
  it("reads the remote branch's commit with ls-remote of the clone's remote, in the clone, matching the ref exactly (ADR 0137)", async () => {
    const listed = [
      `${'e'.repeat(40)}\trefs/heads/${branch}-old`,
      `${TIP}\trefs/heads/${branch}`,
      '',
    ].join('\n');
    const { git, calls } = recordingGit(() => ok(listed));
    assert.equal(await openBranchPush({ git, clone }).remoteTip(branch), TIP);
    assert.deepEqual(
      calls.map(({ cwd, args }) => [cwd, ...args]),
      [[clone, 'ls-remote', '--refs', 'origin', `refs/heads/${branch}`]],
    );
    assert.deepEqual(calls[0]?.options?.config, IN_CLONE);
    const other = recordingGit(() => ok(listed));
    await openBranchPush({ git: other.git, clone, remote: 'upstream' }).remoteTip(branch);
    assert.equal(other.calls[0]?.args[2], 'upstream');
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

describe('listRemoteRefs (ADR 0106)', () => {
  it("lists every ref of the URL Foedrum names from a git directory of its own, under a deadline, never through the clone's configuration", async () => {
    const listed = `${TIP}\trefs/heads/main\n`;
    const root = nextFolder();
    const gitDir = join(root, 'f1.git');
    const { git, calls } = recordingGit((args) => named(args) ?? ok(listed));
    const signal = new AbortController().signal;
    assert.equal(
      await listRemoteRefs({ git, clone, own: { url, root, id: () => 'f1' } }, signal),
      listed,
    );
    const [list] = calls.slice(-1);
    assert.deepEqual(
      [list?.cwd, ...(list?.args ?? [])],
      [root, `--git-dir=${gitDir}`, 'ls-remote', '--refs', url],
    );
    assert.deepEqual(list?.options?.config, OWN_CONFIG);
    assert.equal(list?.options?.signal, signal);
    assert.equal(list?.options?.timeoutMs, 60_000);
    // A repository with many pull requests lists many refs: past the runner's default 4 MiB.
    assert.equal(list?.options?.maxOutputBytes, 64 * 1024 * 1024);
    assert.equal(existsSync(gitDir), false);
  });

  it("fails when git does, and with no URL of Foedrum's before git runs", async () => {
    const down = recordingGit(
      (args) =>
        named(args) ??
        (args.includes('ls-remote')
          ? failed('fatal: could not read from remote repository\n')
          : ok()),
    );
    await assert.rejects(
      listRemoteRefs({ git: down.git, clone, own: { url, root: nextFolder() } }),
      {
        message: 'git ls-remote failed: fatal: could not read from remote repository',
      },
    );
    const { git, calls } = recordingGit();
    await assert.rejects(listRemoteRefs({ git, clone }), {
      message: `The pushes from ${clone} name no URL to reach the remote by`,
    });
    assert.deepEqual(calls, []);
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
  it("pushes the commit by its sha to the clone's remote, without force, in the clone (ADR 0137)", async () => {
    const { git, calls } = recordingGit();
    const signal = new AbortController().signal;
    await openBranchPush({ git, clone }).push(TIP, branch, signal);
    assert.deepEqual(
      calls.map(({ cwd, args }) => [cwd, ...args]),
      [[clone, 'push', '--no-verify', 'origin', `${TIP}:refs/heads/${branch}`]],
    );
    assert.equal(calls[0]?.options?.signal, signal);
    assert.equal(calls[0]?.options?.timeoutMs, 300_000);
  });

  it("runs no hook of the clone's (review of #198) and no fsmonitor", async () => {
    const { git, calls } = recordingGit();
    await openBranchPush({ git, clone }).push(TIP, branch);
    assert.deepEqual(calls[0]?.options?.config, IN_CLONE);
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

  it("refuses to fetch the base with no URL of Foedrum's, before git runs: never by the clone's remote", async () => {
    const { git, calls } = recordingGit();
    const push = openBranchPush({ git, clone });
    const message = `The pushes from ${clone} name no URL to reach the remote by`;
    await assert.rejects(push.baseTip('main'), { message });
    assert.deepEqual(calls, []);
  });
});

describe('openBranchPush: git in the clone (ADR 0137)', () => {
  it('runs every call in the clone with no hook or fsmonitor, and every other in its own git directory', async () => {
    const root = nextFolder();
    const { git, calls } = recordingGit((args) => {
      const answer = named(args);
      if (answer !== undefined) return answer;
      if (args.includes('--patch') || args[0] === 'log') return ok('');
      if (args.some((arg) => arg.endsWith('^{commit}')) || args.includes('refs/heads/main'))
        return ok(`${TIP}\n`);
      return ok();
    });
    const push = openBranchPush({ git, clone, own: { url, root } });
    await push.commit('refs/heads/x');
    await push.isAncestor(TIP, TIP);
    await push.remoteTip(branch);
    await push.push(TIP, branch);
    await push.baseTip('main');
    await push.secretScan('b'.repeat(40), TIP);
    const inClone = calls.filter(({ cwd }) => cwd === clone);
    assert.ok(inClone.length >= 9, String(inClone.length));
    for (const { args, options } of inClone) {
      for (const [key, value] of Object.entries(IN_CLONE)) {
        assert.equal(options?.config?.[key], value, `${key} of ${args.join(' ')}`);
      }
    }
    for (const { args } of calls.filter(({ cwd }) => cwd !== clone)) {
      assert.match(args[0] ?? '', /^--git-dir=/);
    }
  });
});

describe('openBranchPush: baseTip (ADR 0090)', () => {
  const OLD = 'b'.repeat(40);
  let root: string;
  let gitDir: string;
  let base: { url: string; root: string };
  beforeEach(() => {
    root = nextFolder();
    gitDir = join(root, 'f1.git');
    base = { url, root };
  });
  /** The git directory of each fetch: f1, f2, … */
  const ids = () => {
    let n = 0;
    return () => `f${++n}`;
  };
  /** A clone at `/work/acme.api/clone` whose origin/main is at OLD, and a remote main at TIP. */
  const answers = (args: readonly string[]): GitResult => {
    if (args.includes('--git-common-dir')) return ok(`${clone}\nsha1\n`);
    if (args.includes('refs/remotes/origin/main^{commit}')) return ok(`${OLD}\n`);
    if (args.includes('refs/heads/main')) return ok(`${TIP}\n`);
    return ok();
  };

  it("fetches the remote's base into a git directory of the fetch's own, from the clone's origin/<base>, writing into the clone's objects", async () => {
    const { git, calls } = recordingGit(answers);
    const push = openBranchPush({ git, clone, own: { ...base, id: ids() } });
    assert.equal(await push.baseTip('main'), TIP);
    assert.deepEqual(
      calls.map(({ cwd, args }) => [cwd, ...args]),
      [
        [clone, 'rev-parse', '--path-format=absolute', '--git-common-dir', '--show-object-format'],
        [
          root,
          `--git-dir=${gitDir}`,
          'init',
          '--bare',
          '--quiet',
          '--template=',
          '--object-format=sha1',
        ],
        [
          clone,
          'rev-parse',
          '--verify',
          '--quiet',
          '--end-of-options',
          'refs/remotes/origin/main^{commit}',
        ],
        [root, `--git-dir=${gitDir}`, 'update-ref', 'refs/heads/main', OLD],
        [clone, 'config', '--get-regexp', '^(extensions\\.partialclone|remote\\..*\\.promisor)$'],
        [
          root,
          `--git-dir=${gitDir}`,
          'fetch',
          '--quiet',
          '--no-tags',
          '--no-write-fetch-head',
          '--no-recurse-submodules',
          '--no-auto-maintenance',
          '--end-of-options',
          url,
          '+refs/heads/main:refs/heads/main',
        ],
        [
          root,
          `--git-dir=${gitDir}`,
          'rev-parse',
          '--verify',
          '--quiet',
          '--end-of-options',
          'refs/heads/main',
        ],
      ],
    );
    // The ref is the fetch's boundary: what it walks after the fetch stops at the clone's base.
    assert.equal(calls[3]?.options?.env?.GIT_OBJECT_DIRECTORY, join(clone, 'objects'));
    const fetch = calls[5]?.options;
    assert.equal(fetch?.env?.GIT_OBJECT_DIRECTORY, join(clone, 'objects'));
    assert.equal(fetch?.config?.['core.hooksPath'], devNull);
    assert.equal(fetch?.config?.['gc.auto'], '0');
    assert.equal(fetch?.timeoutMs, 300_000);
  });

  it('fetches the base of a partial clone with its filter, from the URL Foedrum names as a promisor of its own git directory (review of #266)', async () => {
    // As older gits make a blobless clone, and as git 2.56 does: a promisor remote only.
    for (const said of ['extensions.partialclone origin\n', 'remote.origin.promisor true\n']) {
      const { git, calls } = recordingGit((args) =>
        args.includes('--get-regexp') ? ok(said) : answers(args),
      );
      root = nextFolder();
      gitDir = join(root, 'f1.git');
      assert.equal(
        await openBranchPush({ git, clone, own: { url, root, id: ids() } }).baseTip('main'),
        TIP,
      );
      const configs = calls.filter(
        ({ args }) => args[0] === `--git-dir=${gitDir}` && args[1] === 'config',
      );
      assert.deepEqual(
        configs.map(({ args }) => args.slice(1)),
        [
          ['config', 'core.repositoryformatversion', '1'],
          ['config', 'extensions.partialClone', 'foedrum'],
        ],
        said,
      );
      const fetch = calls.find(({ args }) => args.includes('fetch'));
      assert.deepEqual(fetch?.args.slice(-4), [
        '--filter=blob:none',
        '--end-of-options',
        'foedrum',
        '+refs/heads/main:refs/heads/main',
      ]);
      assert.deepEqual(fetch?.options?.config, {
        'remote.foedrum.url': url,
        'remote.foedrum.promisor': 'true',
        'remote.foedrum.partialclonefilter': 'blob:none',
        'core.hooksPath': devNull,
        'gc.auto': '0',
        'maintenance.auto': 'false',
      });
    }
  });

  it('fetches the base of a clone whose promisor setting is false as a full clone, by the URL, with no promisor (review of #266)', async () => {
    const { git, calls } = recordingGit((args) =>
      args.includes('--get-regexp') ? ok('remote.origin.promisor false\n') : answers(args),
    );
    await openBranchPush({ git, clone, own: { ...base, id: ids() } }).baseTip('main');
    assert.deepEqual(
      calls.filter(({ args }) => args[0] === `--git-dir=${gitDir}` && args[1] === 'config'),
      [],
    );
    const fetch = calls.find(({ args }) => args.includes('fetch'));
    assert.equal(fetch?.args.at(-2), url);
    assert.ok(!fetch?.args.some((arg) => arg.startsWith('--filter')), fetch?.args.join(' '));
  });

  it('sets no ref when the clone has no origin/<base>, or git names none, and passes the signal to every call', async () => {
    for (const known of [failed(''), ok('not a sha\n')]) {
      const { git, calls } = recordingGit((args) =>
        args.includes('refs/remotes/origin/main^{commit}') ? known : answers(args),
      );
      const push = openBranchPush({ git, clone, own: base });
      const { signal } = new AbortController();
      assert.equal(await push.baseTip('main', signal), TIP);
      assert.equal(
        calls.some(({ args }) => args.includes('update-ref')),
        false,
      );
      assert.deepEqual(
        calls.map(({ options }) => options?.signal === signal),
        [true, true, true, true, true, true],
      );
    }
  });

  it('gives every fetch a git directory of its own in the root, and removes it after, also when git fails (review of #254)', async () => {
    // A git whose init makes the directory it names, as git would.
    const made: string[] = [];
    const { git, calls } = recordingGit((args) => {
      if (args.includes('init')) {
        const dir = (args[0] ?? '').slice('--git-dir='.length);
        mkdirSync(dir, { recursive: true });
        made.push(dir);
      }
      if (args.includes('fetch') && made.length === 3) return failed('fatal: unreachable\n');
      return answers(args);
    });
    const push = openBranchPush({ git, clone, own: base });
    await Promise.all([push.baseTip('main'), push.baseTip('main')]);
    await assert.rejects(push.baseTip('main'), { message: 'git fetch failed: fatal: unreachable' });
    assert.equal(new Set(made).size, 3);
    for (const dir of made) {
      assert.equal(dirname(dir), root);
      assert.equal(existsSync(dir), false, dir);
    }
    const dirs = calls
      .filter(({ args }) => args[0]?.startsWith('--git-dir='))
      .map(({ args }) => args[0]);
    assert.equal(new Set(dirs).size, 3);
  });

  it('runs no hook, gc or maintenance of its own for the fetch, which sees only the ref Foedrum fetched (review of #254)', async () => {
    const { git, calls } = recordingGit(answers);
    await openBranchPush({ git, clone, own: base }).baseTip('main');
    const fetch = calls.find(({ args }) => args.includes('fetch'));
    assert.deepEqual(fetch?.options?.config, {
      'core.hooksPath': devNull,
      'gc.auto': '0',
      'maintenance.auto': 'false',
    });
  });

  it('takes a base whose name has a slash and a dot (review of #254)', async () => {
    const { git, calls } = recordingGit((args) =>
      args.includes('refs/heads/release/1.0') ? ok(`${TIP}\n`) : answers(args),
    );
    assert.equal(await openBranchPush({ git, clone, own: base }).baseTip('release/1.0'), TIP);
    const fetch = calls.find(({ args }) => args.includes('fetch'));
    assert.equal(fetch?.args.at(-1), '+refs/heads/release/1.0:refs/heads/release/1.0');
  });

  it('fails when git names no git directory of the clone, or the fetched ref no commit (review of #254)', async () => {
    const nameless = recordingGit((args) =>
      args.includes('--git-common-dir') ? ok('\n') : answers(args),
    );
    await assert.rejects(openBranchPush({ git: nameless.git, clone, own: base }).baseTip('main'), {
      message: `git rev-parse did not name the git directory of ${clone}`,
    });
    assert.equal(
      nameless.calls.some(({ args }) => args.includes('fetch')),
      false,
    );
    // Only the clone's path, with no line after it or an empty one; and an empty path before the
    // format.
    for (const answer of [clone, `${clone}\n`, '\nsha1\n']) {
      const half = recordingGit((args) =>
        args.includes('--git-common-dir') ? ok(answer) : answers(args),
      );
      await assert.rejects(openBranchPush({ git: half.git, clone, own: base }).baseTip('main'), {
        message: `git rev-parse did not name the git directory of ${clone}`,
      });
      assert.equal(half.calls.length, 1, JSON.stringify(answer));
    }
    const odd = recordingGit((args) =>
      args.includes('refs/heads/main') ? ok('not a sha\n') : answers(args),
    );
    await assert.rejects(openBranchPush({ git: odd.git, clone, own: base }).baseTip('main'), {
      message: 'The fetch of main named no commit: not a sha',
    });
  });

  it("fails with git's reason when the remote has no such branch", async () => {
    const { git } = recordingGit((args) =>
      args.includes('fetch')
        ? failed("fatal: couldn't find remote ref refs/heads/main\n")
        : answers(args),
    );
    await assert.rejects(openBranchPush({ git, clone, own: base }).baseTip('main'), {
      message: "git fetch failed: fatal: couldn't find remote ref refs/heads/main",
    });
  });

  it('refuses a base that git would read as an option or a refspec, and a push with no base fetch, before git runs', async () => {
    const { git, calls } = recordingGit(answers);
    for (const name of ['--upload-pack=x', '-main', 'main:refs/heads/x', 'a..b', 'ma in', '']) {
      await assert.rejects(openBranchPush({ git, clone, own: base }).baseTip(name), {
        message: `${JSON.stringify(name)} is no branch name`,
      });
    }
    await assert.rejects(openBranchPush({ git, clone }).baseTip('main'), {
      message: `The pushes from ${clone} name no URL to reach the remote by`,
    });
    assert.deepEqual(calls, []);
  });
});

describe('openBranchPush: signals and time', () => {
  it('passes the signal to every git call, with time for a large push', async () => {
    const { git, calls } = recordingGit(
      (args) => named(args) ?? (args[0] === 'rev-parse' ? ok(`${TIP}\n`) : ok('')),
    );
    const push = openBranchPush({ git, clone, own: { url, root: nextFolder() } });
    const { signal } = new AbortController();
    await push.commit('refs/heads/x', signal);
    await push.remoteTip(branch, signal);
    await push.push(TIP, branch, signal);
    assert.deepEqual(
      calls.map(({ options }) => options?.signal === signal),
      [true, true, true, true, true, true, true],
    );
    assert.equal(calls[6]?.options?.timeoutMs, 300_000);
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
  const plainHeaders = [
    `commit ${TIP}`,
    'author Brewer <brewer@example.com> 1792484716 +0200',
    'committer Brewer <brewer@example.com> 1792484716 +0200',
    '',
    '    Clean',
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
          '--no-color',
          '--no-abbrev-commit',
          '--encoding=none',
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
        // No transport, whatever protocol.<name>.allow the clone says (ADR 0096).
        GIT_ALLOW_PROTOCOL: '',
      });
      assert.deepEqual(options?.config, {
        'core.attributesFile': devNull,
        'log.showRoot': 'true',
        'advice.graftFileDeprecated': 'false',
        // No transport at all, whatever the git version: a lazy fetch fails here instead.
        'protocol.allow': 'never',
        // And no hook or fsmonitor, as every call in the clone (ADR 0096).
        'core.hooksPath': devNull,
        'core.fsmonitor': 'false',
      });
    }
  });

  it('keeps a hexadecimal word the clone has as no commit: git answers missing, or another type', async () => {
    const key = 'd'.repeat(40);
    const blob = 'e'.repeat(40);
    const { git } = recordingGit((args) => {
      if (args.includes('--format=raw')) return ok(plainHeaders);
      return args[0] === 'log'
        ? ok(args.includes('--patch') ? '' : `\0${TIP}\nUse ${key}\nand ${blob}\n`)
        : ok(`${key} missing\n${blob} blob\n`);
    });
    assert.deepEqual(await openBranchPush({ git, clone }).secretScan(BASE, TIP), [
      { commit: TIP, place: 'message', kind: 'long hexadecimal string' },
    ]);
  });

  // Review of #237: `git merge --squash` writes `commit <sha>` lines into the message.
  it('asks the objects about a commit a message names on a line of its own', async () => {
    const { git, calls } = recordingGit((args) => {
      if (args.includes('--format=raw')) return ok(plainHeaders);
      if (args[0] === 'cat-file') return ok(`${known} commit\n`);
      return ok(args.includes('--patch') ? '' : `\0${TIP}\nSquashed\n\ncommit ${known}\n`);
    });
    assert.deepEqual(await openBranchPush({ git, clone }).secretScan(BASE, TIP), []);
    assert.equal(calls.at(-1)?.options?.stdin, `${known}\n`);
  });

  it('asks nothing of the objects when no word may be a commit', async () => {
    const { git, calls } = recordingGit((args) => {
      if (args.includes('--format=raw')) return ok(plainHeaders);
      return args[0] === 'log' ? ok(`\0${TIP}\nClean\n`) : failed('unexpected');
    });
    assert.deepEqual(await openBranchPush({ git, clone }).secretScan(BASE, TIP), []);
    assert.deepEqual(
      calls.map(({ args }) => args[0]),
      ['log', 'log', 'log'],
    );
  });

  // Consultant-round review of #237: a clone setting (color.ui=always) once hid every commit line.
  it('refuses when the headers read shows other commits than the messages read', async () => {
    const coloured = `\u001b[33mcommit ${TIP}\u001b[m\nauthor ${token} <x@y.z> 1 +0000\n\n    Clean\n`;
    for (const headers of [coloured, '']) {
      const { git } = recordingGit((args) => {
        if (args.includes('--format=raw')) return ok(headers);
        return ok(args.includes('--patch') ? '' : `\0${TIP}\nClean\n`);
      });
      assert.deepEqual(await openBranchPush({ git, clone }).secretScan(BASE, TIP), [
        {
          commit: TIP,
          place: `the commits from ${BASE}`,
          kind: 'headers git did not show as stored',
        },
      ]);
    }
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
