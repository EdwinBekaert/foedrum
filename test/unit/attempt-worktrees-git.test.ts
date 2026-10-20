import assert from 'node:assert/strict';
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { devNull } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, it } from 'node:test';
import {
  ensureManagedClone,
  openAttemptWorktrees,
} from '../../src/workspace/attempt-worktrees-git.ts';
import type { Git } from '../../src/workspace/git.ts';
import {
  attempt,
  BASE,
  branch,
  failed,
  fakeGit,
  ok,
  porcelain,
  suiteFolders,
  TIP,
} from '../helpers/attempt-worktrees.ts';

describe('openAttemptWorktrees with a fake git', () => {
  const nextFolder = suiteFolders('attempt-worktrees');
  let dir: { path: string };
  let clone: string;
  let workRoot: string;
  let root: string;
  let path: string;

  beforeEach(() => {
    dir = { path: nextFolder() };
    clone = join(dir.path, 'clone');
    workRoot = join(dir.path, 'work');
    root = join(workRoot, 'acme.app', 'attempts');
    path = join(root, '12-1', 'implement', '1');
    mkdirSync(join(clone, '.git', 'worktrees'), { recursive: true });
  });

  const url = 'https://github.com/acme/app.git';
  const open = (git: Git, now?: () => number) =>
    openAttemptWorktrees({
      git,
      workRoot,
      repo: 'acme/app',
      clone,
      own: { url, root: join(workRoot, 'git'), id: () => 'f1' },
      ...(now === undefined ? {} : { now }),
    });

  // A worktree on disk with its record, as git leaves it.
  const worktreeOnDisk = (folder: string, name: string): string => {
    const record = join(clone, '.git', 'worktrees', name);
    mkdirSync(folder, { recursive: true });
    mkdirSync(record, { recursive: true });
    writeFileSync(join(folder, '.git'), `gitdir: ${record}\n`);
    writeFileSync(join(record, 'gitdir'), `${join(folder, '.git')}\n`);
    return record;
  };

  describe('create', () => {
    it('fetches, then adds the attempt branch at the base commit in the attempts root', async () => {
      const { calls, git } = fakeGit((_cwd, args) => {
        if (args[0] === 'rev-parse' && args.includes('origin/main^{commit}'))
          return ok(`${BASE}\n`);
        if (args[0] === 'rev-parse') return { code: 1, stdout: '', stderr: '' };
        if (args[0] === 'worktree' && args[1] === 'list')
          return ok(porcelain([{ path: clone, branch: 'main' }]));
        return undefined;
      });

      const worktree = await open(git).create(attempt, 'origin/main');

      assert.deepEqual(worktree, { path, branch, commit: BASE });
      const own = join(workRoot, 'git');
      const gitDir = `--git-dir=${join(own, 'f1.git')}`;
      const refs = ['for-each-ref', '--format=%(objectname) %(refname)', 'refs/remotes/origin/'];
      assert.deepEqual(calls, [
        [clone, 'rev-parse', '--path-format=absolute', '--git-common-dir', '--show-object-format'],
        [own, gitDir, 'init', '--bare', '--quiet', '--template=', '--object-format=sha1'],
        [clone, ...refs],
        [clone, 'config', '--get-regexp', '^(extensions\\.partialclone|remote\\..*\\.promisor)$'],
        [
          own,
          gitDir,
          'fetch',
          '--quiet',
          '--no-tags',
          '--no-write-fetch-head',
          '--no-recurse-submodules',
          '--no-auto-maintenance',
          '--prune',
          '--end-of-options',
          url,
          '+refs/heads/*:refs/remotes/origin/*',
        ],
        [own, gitDir, ...refs],
        [clone, 'rev-parse', '--verify', '--quiet', '--end-of-options', 'origin/main^{commit}'],
        [clone, 'worktree', 'list', '--porcelain', '-z'],
        [clone, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`],
        [clone, 'worktree', 'add', '-b', branch, '--', path, BASE],
      ]);
    });

    it("fetches into a git directory of its own from the clone's remote refs, and writes back only the refs that moved (ADR 0096)", async () => {
      const own = join(workRoot, 'git');
      const OLD = 'a'.repeat(40);
      const { calls, options, git } = fakeGit((cwd, args) => {
        if (args.includes('for-each-ref')) {
          // origin/HEAD and origin/main as the clone has them; main moves, and a branch is new.
          const before = `${BASE} refs/remotes/origin/HEAD\n${BASE} refs/remotes/origin/main\n${OLD} refs/remotes/origin/old\n`;
          const after = `${BASE} refs/remotes/origin/HEAD\n${TIP} refs/remotes/origin/main\n${OLD} refs/remotes/origin/old\n${TIP} refs/remotes/origin/new\n`;
          return ok(cwd === clone ? before : after);
        }
        if (args.includes('origin/main^{commit}')) return ok(`${TIP}\n`);
        if (args[0] === 'rev-parse' && !args.includes('--show-object-format')) return failed('');
        if (args[0] === 'worktree' && args[1] === 'list') return ok('');
        return undefined;
      });

      await open(git).create(attempt, 'origin/main');

      const updates = calls.flatMap((call, i) =>
        call.includes('update-ref') ? [{ cwd: call[0], stdin: options[i]?.stdin }] : [],
      );
      assert.deepEqual(updates, [
        {
          cwd: own,
          stdin: `update refs/remotes/origin/HEAD ${BASE}\nupdate refs/remotes/origin/main ${BASE}\nupdate refs/remotes/origin/old ${OLD}\n`,
        },
        {
          cwd: clone,
          stdin: `update refs/remotes/origin/main ${TIP}\nupdate refs/remotes/origin/new ${TIP}\n`,
        },
      ]);
      const fetch = calls.findIndex((call) => call.includes('fetch'));
      assert.equal(options[fetch]?.env?.GIT_OBJECT_DIRECTORY, join(clone, '.git', 'objects'));
      assert.deepEqual(options[fetch]?.config, {
        'core.hooksPath': devNull,
        'gc.auto': '0',
        'maintenance.auto': 'false',
      });
      assert.equal(existsSync(join(own, 'f1.git')), false);
    });

    it('prunes the tracking refs the remote no longer has, before the updates, and keeps origin/HEAD (review of #266)', async () => {
      const OLD = 'a'.repeat(40);
      const { calls, options, git } = fakeGit((cwd, args) => {
        if (args.includes('for-each-ref')) {
          // The remote deleted x and made x/y: git cannot have both refs at once.
          const before = `${BASE} refs/remotes/origin/HEAD\n${BASE} refs/remotes/origin/main\n${OLD} refs/remotes/origin/x\n`;
          const after = `${BASE} refs/remotes/origin/main\n${TIP} refs/remotes/origin/x/y\n`;
          return ok(cwd === clone ? before : after);
        }
        if (args.includes('origin/main^{commit}')) return ok(`${BASE}\n`);
        if (args[0] === 'rev-parse') return failed('');
        if (args[0] === 'worktree' && args[1] === 'list') return ok('');
        return undefined;
      });

      await open(git).create(attempt, 'origin/main');

      const fetch = calls.find((call) => call.includes('fetch'));
      assert.ok(fetch?.includes('--prune'), fetch?.join(' '));
      const written = calls.flatMap((call, i) =>
        call[0] === clone && call.includes('update-ref') ? [options[i]?.stdin] : [],
      );
      assert.deepEqual(written, [
        `delete refs/remotes/origin/x ${OLD}\n`,
        `update refs/remotes/origin/x/y ${TIP}\n`,
      ]);
    });

    it('fetches into a partial clone with its filter, from the URL Foedrum names as a promisor of its own git directory, so a delta of a file the clone lacks resolves (review of #266)', async () => {
      const own = join(workRoot, 'git');
      const gitDir = `--git-dir=${join(own, 'f1.git')}`;
      const { calls, options, git } = fakeGit((_cwd, args) => {
        // As git 2.56 makes a blobless clone: a promisor remote, no extensions.partialClone.
        if (args.includes('--get-regexp')) return ok('remote.origin.promisor true\n');
        if (args.includes('origin/main^{commit}')) return ok(`${BASE}\n`);
        if (args[0] === 'rev-parse') return failed('');
        if (args[0] === 'worktree' && args[1] === 'list') return ok('');
        return undefined;
      });

      await open(git).create(attempt, 'origin/main');

      const configs = calls.filter((call) => call[1] === gitDir && call[2] === 'config');
      assert.deepEqual(
        configs.map((call) => call.slice(2)),
        [
          ['config', 'core.repositoryformatversion', '1'],
          ['config', 'extensions.partialClone', 'foedrum'],
        ],
      );
      const fetch = calls.findIndex((call) => call.includes('fetch'));
      assert.deepEqual(calls[fetch]?.slice(-4), [
        '--filter=blob:none',
        '--end-of-options',
        'foedrum',
        '+refs/heads/*:refs/remotes/origin/*',
      ]);
      assert.deepEqual(options[fetch]?.config, {
        'remote.foedrum.url': url,
        'remote.foedrum.promisor': 'true',
        'remote.foedrum.partialclonefilter': 'blob:none',
        'core.hooksPath': devNull,
        'gc.auto': '0',
        'maintenance.auto': 'false',
      });
    });

    it('fetches a clone whose promisor setting is false as a full clone, by the URL, with no promisor (review of #266)', async () => {
      const gitDir = `--git-dir=${join(workRoot, 'git', 'f1.git')}`;
      const { calls, git } = fakeGit((_cwd, args) => {
        if (args.includes('--get-regexp')) return ok('remote.origin.promisor false\n');
        if (args.includes('origin/main^{commit}')) return ok(`${BASE}\n`);
        if (args[0] === 'rev-parse') return failed('');
        if (args[0] === 'worktree' && args[1] === 'list') return ok('');
        return undefined;
      });

      await open(git).create(attempt, 'origin/main');

      assert.deepEqual(
        calls.filter((call) => call[1] === gitDir && call[2] === 'config'),
        [],
      );
      const fetch = calls.find((call) => call.includes('fetch'));
      assert.equal(fetch?.at(-2), url);
      assert.ok(!fetch?.some((arg) => arg.startsWith('--filter')), fetch?.join(' '));
    });

    it('runs every git call in the clone with no transport, hook or fsmonitor, and the checkout with no hook or fsmonitor (ADR 0096)', async () => {
      const { calls, options, git } = fakeGit((_cwd, args) => {
        if (args.includes('origin/main^{commit}')) return ok(`${BASE}\n`);
        if (args[0] === 'rev-parse' && !args.includes('--show-object-format')) return failed('');
        if (args[0] === 'worktree' && args[1] === 'list') return ok('');
        return undefined;
      });

      await open(git).create(attempt, 'origin/main');

      const inClone = calls.flatMap((call, i) => (call[0] === clone ? [{ call, i }] : []));
      assert.ok(inClone.length >= 5, String(inClone.length));
      for (const { call, i } of inClone) {
        const { env, config } = options[i] ?? {};
        assert.equal(config?.['core.hooksPath'], devNull, call.join(' '));
        assert.equal(config?.['core.fsmonitor'], 'false', call.join(' '));
        if (call[1] === 'worktree' && call[2] === 'add') continue;
        // The checkout of a partial clone downloads its files; nothing else in the clone may.
        assert.equal(config?.['protocol.allow'], 'never', call.join(' '));
        assert.equal(env?.GIT_NO_LAZY_FETCH, '1', call.join(' '));
        // Over any protocol.<name>.allow of the clone's configuration (review of #266).
        assert.equal(env?.GIT_ALLOW_PROTOCOL, '', call.join(' '));
      }
    });

    it('throws, without adding anything, when the fetch or the base fails', async () => {
      const fetchFails = fakeGit((_cwd, args) => (args.includes('fetch') ? failed() : undefined));
      await assert.rejects(open(fetchFails.git).create(attempt, 'origin/main'), /fetch/);
      const noBase = fakeGit((_cwd, args) => (args[0] === 'rev-parse' ? failed('') : undefined));
      await assert.rejects(open(noBase.git).create(attempt, 'origin/nope'), /origin\/nope/);
      for (const { calls } of [fetchFails, noBase]) {
        assert.ok(!calls.some(([, ...args]) => args[0] === 'worktree' && args[1] === 'add'));
      }
    });

    it('throws when a folder git does not know is in the way', async () => {
      mkdirSync(path, { recursive: true });
      const { calls, git } = fakeGit((_cwd, args) => {
        if (args.includes('origin/main^{commit}')) return ok(`${BASE}\n`);
        if (args[0] === 'rev-parse') return { code: 1, stdout: '', stderr: '' };
        return undefined;
      });

      await assert.rejects(open(git).create(attempt, 'origin/main'), /12-1\/implement\/1/);
      assert.ok(!calls.some(([, ...args]) => args[0] === 'worktree' && args[1] === 'add'));
    });

    it('gives the checkout as long as a fetch: a partial clone downloads every file then', async () => {
      const deadlines = new Map<string, number | undefined>();
      const git: Git = async (cwd, args, options) => {
        const command = args.filter((arg) => !arg.startsWith('--git-dir='));
        deadlines.set(command.slice(0, 2).join(' '), options?.timeoutMs);
        if (args.includes('--show-object-format')) return ok(`${join(cwd, '.git')}\nsha1\n`);
        if (args.includes('origin/main^{commit}')) return ok(`${BASE}\n`);
        if (args[0] === 'rev-parse') return { code: 1, stdout: '', stderr: '' };
        if (args[0] === 'worktree' && args[1] === 'list') return ok('');
        return ok();
      };

      await open(git).create(attempt, 'origin/main');

      assert.equal(deadlines.get('worktree add'), deadlines.get('fetch --quiet'));
      assert.ok((deadlines.get('worktree add') ?? 0) >= 300_000);
    });

    it('fetches one at a time when attempts start together: git locks the refs it updates', async () => {
      let running = 0;
      let most = 0;
      const git: Git = async (cwd, args) => {
        if (args.includes('--show-object-format')) return ok(`${join(cwd, '.git')}\nsha1\n`);
        if (args.includes('fetch')) {
          running += 1;
          most = Math.max(most, running);
          await new Promise((resolve) => setImmediate(resolve));
          running -= 1;
          return ok();
        }
        if (args.includes('origin/main^{commit}')) return ok(`${BASE}\n`);
        if (args[0] === 'rev-parse') return { code: 1, stdout: '', stderr: '' };
        if (args[0] === 'worktree' && args[1] === 'list') return ok('');
        return ok();
      };
      const worktrees = open(git);

      await Promise.all([
        worktrees.create(attempt, 'origin/main'),
        worktrees.create({ ...attempt, stepId: 'review' }, 'origin/main'),
      ]);

      assert.equal(most, 1);
    });

    it('refuses an attempt id that is no path segment before running git', async () => {
      const { calls, git } = fakeGit();
      await assert.rejects(open(git).create({ ...attempt, batchId: '../x' }, BASE), /attempt/i);
      assert.deepEqual(calls, []);
    });
  });

  describe('recreate', () => {
    it('checks out the branch of a resumed attempt again when its worktree is gone', async () => {
      const { calls, git } = fakeGit((_cwd, args) => {
        if (args[0] === 'rev-parse') return ok(`${TIP}\n`);
        if (args[0] === 'worktree' && args[1] === 'list')
          return ok(porcelain([{ path: clone, branch: 'main' }]));
        return undefined;
      });

      const worktree = await open(git).recreate(attempt, BASE);

      assert.deepEqual(worktree, { path, branch, commit: TIP });
      assert.deepEqual(calls.at(-1), [clone, 'worktree', 'add', '--', path, branch]);
      assert.ok(!calls.some((call) => call.includes('fetch')));
    });

    it('refuses a recorded commit that is no commit, before adding anything', async () => {
      const { calls, git } = fakeGit((_cwd, args) => {
        if (args[0] === 'rev-parse') return { code: 1, stdout: '', stderr: '' };
        if (args[0] === 'worktree' && args[1] === 'list') return ok('');
        return undefined;
      });

      await assert.rejects(open(git).recreate(attempt, '--orphan'), /--orphan/);
      assert.ok(
        calls.some(
          (call) => call.includes('--end-of-options') && call.includes('--orphan^{commit}'),
        ),
      );
      assert.ok(!calls.some(([, ...args]) => args[0] === 'worktree' && args[1] === 'add'));
    });

    it('gives back the worktree that is there', async () => {
      worktreeOnDisk(path, 'implement1');
      const { calls, git } = fakeGit((_cwd, args) => {
        if (args.includes('--git-common-dir')) return ok(`${join(clone, '.git')}\n`);
        if (args[0] === 'rev-parse') return ok(`${TIP}\n`);
        if (args[0] === 'worktree' && args[1] === 'list') return ok(porcelain([{ path, branch }]));
        if (args.includes('status')) return ok(' M file.txt\n');
        return undefined;
      });

      assert.deepEqual(await open(git).recreate(attempt, BASE), { path, branch, commit: TIP });
      assert.ok(!calls.some(([, ...args]) => args[0] === 'worktree' && args[1] === 'add'));
    });

    it('prunes the record a crash left at the folder before adding the worktree again', async () => {
      // The folder is gone; only its record is left.
      const record = worktreeOnDisk(path, 'implement1');
      rmSync(path, { recursive: true });
      let recordAtAdd: boolean | undefined;
      const { git } = fakeGit((_cwd, args) => {
        if (args.includes('--git-common-dir')) return ok(`${join(clone, '.git')}\n`);
        if (args.includes(`${BASE}^{commit}`)) return ok(`${BASE}\n`);
        if (args[0] === 'rev-parse') return { code: 1, stdout: '', stderr: '' };
        if (args[0] === 'worktree' && args[1] === 'list') return ok(porcelain([{ path, branch }]));
        if (args[0] === 'worktree' && args[1] === 'add') recordAtAdd = existsSync(record);
        return undefined;
      });

      const worktree = await open(git).recreate(attempt, BASE);

      assert.deepEqual(worktree, { path, branch, commit: BASE });
      assert.equal(recordAtAdd, false);
    });
  });
});

describe('ensureManagedClone with a fake git', () => {
  const nextFolder = suiteFolders('managed-clone');
  let dir: { path: string };
  beforeEach(() => {
    dir = { path: nextFolder() };
  });

  it('makes a bare partial clone once, through a folder it renames when the clone is done', async () => {
    const folder = join(dir.path, 'acme.app');
    const partial = join(folder, 'clone.partial');
    mkdirSync(join(partial, 'half'), { recursive: true });
    const { calls, git } = fakeGit((_cwd, args) => {
      if (args[0] === 'clone') mkdirSync(args.at(-1) ?? '', { recursive: true });
      return undefined;
    });
    const options = {
      git,
      workRoot: dir.path,
      repo: 'Acme/App',
      url: 'https://github.com/acme/app.git',
      reference: '/home/me/app',
    };

    const path = await ensureManagedClone(options);

    assert.equal(path, join(folder, 'clone.git'));
    assert.deepEqual(calls, [
      [
        folder,
        'clone',
        '--bare',
        '--filter=blob:none',
        '--reference',
        '/home/me/app',
        '--',
        'https://github.com/acme/app.git',
        partial,
      ],
      [partial, 'config', 'remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*'],
    ]);
    assert.ok(existsSync(path));
    assert.equal(existsSync(partial), false);
    // Made once: the next call finds it.
    assert.equal(await ensureManagedClone(options), path);
    assert.equal(calls.length, 2);
  });

  it('throws, leaving no clone, when the clone fails', async () => {
    const { git } = fakeGit((_cwd, args) => (args[0] === 'clone' ? failed() : undefined));
    const options = { git, workRoot: dir.path, repo: 'acme/app', url: 'https://x/acme/app.git' };
    await assert.rejects(ensureManagedClone(options), /clone/);
    assert.equal(existsSync(join(dir.path, 'acme.app', 'clone.git')), false);
  });

  it('names the clone URL without its credentials when the clone fails', async () => {
    const { git } = fakeGit((_cwd, args) => (args[0] === 'clone' ? failed() : undefined));
    const url = 'https://user:s3cret-token@github.com/acme/app.git';

    await assert.rejects(
      ensureManagedClone({ git, workRoot: dir.path, repo: 'acme/app', url }),
      (error: Error) => {
        assert.match(error.message, /github\.com\/acme\/app\.git/);
        assert.doesNotMatch(error.message, /s3cret-token|user:/);
        return true;
      },
    );
  });

  it('refuses a clone URL with credentials: they would be in the process list and the config', async () => {
    const { calls, git } = fakeGit();
    const url = 'https://user:s3cret-token@github.com/acme/app.git';

    await assert.rejects(
      ensureManagedClone({ git, workRoot: dir.path, repo: 'acme/app', url }),
      /credential/,
    );
    assert.deepEqual(calls, []);
  });

  it('retries moving the clone into place while Windows holds a file in it', async () => {
    const { git } = fakeGit((_cwd, args) => {
      if (args[0] === 'clone') mkdirSync(args.at(-1) ?? '', { recursive: true });
      return undefined;
    });
    let tries = 0;
    const rename = async (from: string, to: string): Promise<void> => {
      tries += 1;
      if (tries === 1) throw Object.assign(new Error('busy'), { code: 'EPERM' });
      renameSync(from, to);
    };
    const options = { git, workRoot: dir.path, repo: 'acme/app', url: 'https://x/a.git', rename };

    const path = await ensureManagedClone(options);

    assert.equal(tries, 2);
    assert.ok(existsSync(path));
  });

  it('removes what a failed clone left in its partial folder', async () => {
    const { git } = fakeGit((_cwd, args) => {
      if (args[0] !== 'clone') return undefined;
      mkdirSync(join(args.at(-1) ?? '', 'objects'), { recursive: true });
      return failed();
    });
    const options = { git, workRoot: dir.path, repo: 'acme/app', url: 'https://x/acme/app.git' };

    await assert.rejects(ensureManagedClone(options), /git clone of .* failed/);

    assert.equal(existsSync(join(dir.path, 'acme.app', 'clone.partial')), false);
  });
});
