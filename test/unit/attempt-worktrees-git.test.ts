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

    it('runs every git call in the clone with no hook or fsmonitor (ADR 0137)', async () => {
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
        const { config } = options[i] ?? {};
        assert.equal(config?.['core.hooksPath'], devNull, call.join(' '));
        assert.equal(config?.['core.fsmonitor'], 'false', call.join(' '));
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
