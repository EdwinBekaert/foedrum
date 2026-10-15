import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';
import type { AttemptRef } from '../../src/workspace/attempt-worktrees.ts';
import {
  ensureManagedClone,
  openAttemptWorktrees,
} from '../../src/workspace/attempt-worktrees-git.ts';
import type { Git, GitOptions, GitResult } from '../../src/workspace/git.ts';
import { makeTempDir, type TempDir } from '../helpers/temp-dir.ts';

// One temp folder per suite, a fresh subfolder per test: removing a tree per test is slow on
// Windows under the load of a full check (ADR 0021's budget).
const suiteFolders = (prefix: string): (() => string) => {
  let suite: TempDir | undefined;
  let count = 0;
  before(() => {
    suite = makeTempDir(prefix);
  });
  after(() => suite?.remove());
  return () => {
    count += 1;
    const path = join(suite?.path ?? '', String(count));
    mkdirSync(path);
    return path;
  };
};

type Call = [cwd: string, ...args: string[]];
type Answer = (cwd: string, args: readonly string[]) => GitResult | undefined;

const ok = (stdout = ''): GitResult => ({ code: 0, stdout, stderr: '' });
const failed = (stderr = 'fatal: simulated failure\n'): GitResult => ({
  code: 1,
  stdout: '',
  stderr,
});

// A fake git that records every call and answers through `answer`, or with success.
const fakeGit = (answer: Answer = () => undefined) => {
  const calls: Call[] = [];
  const git: Git = async (cwd, args) => {
    calls.push([cwd, ...args]);
    return answer(cwd, args) ?? ok();
  };
  return { calls, git };
};

// `git worktree list --porcelain -z` output for the given worktrees.
const porcelain = (worktrees: { path: string; branch?: string }[]): string =>
  worktrees
    .map(
      ({ path, branch }) =>
        `worktree ${path}\0HEAD ${'1'.repeat(40)}\0${branch === undefined ? 'detached' : `branch refs/heads/${branch}`}\0\0`,
    )
    .join('');

const BASE = 'b'.repeat(40);
const TIP = 'c'.repeat(40);
const attempt: AttemptRef = { batchId: '12-1', stepId: 'implement', attempt: 1 };
const branch = 'foedrum/12-1/implement/1';

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

  const open = (git: Git, now?: () => number) =>
    openAttemptWorktrees({
      git,
      workRoot,
      repo: 'acme/app',
      clone,
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
      assert.deepEqual(calls, [
        [clone, 'fetch', '--quiet', 'origin'],
        [clone, 'rev-parse', '--verify', '--quiet', '--end-of-options', 'origin/main^{commit}'],
        [clone, 'worktree', 'list', '--porcelain', '-z'],
        [clone, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`],
        [clone, 'worktree', 'add', '-b', branch, '--', path, BASE],
      ]);
    });

    it('throws, without adding anything, when the fetch or the base fails', async () => {
      const fetchFails = fakeGit((_cwd, args) => (args[0] === 'fetch' ? failed() : undefined));
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
      const git: Git = async (_cwd, args, options) => {
        deadlines.set(args.slice(0, 2).join(' '), options?.timeoutMs);
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
      const git: Git = async (_cwd, args) => {
        if (args[0] === 'fetch') {
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
      assert.ok(!calls.some(([, ...args]) => args[0] === 'fetch'));
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

  describe('clean', () => {
    const ended = { batches: new Map([['12-1', 'ended' as const]]), leased: [] };

    it('removes the worktree, branch and batch folder of an ended batch', async () => {
      worktreeOnDisk(path, 'implement1');
      const { calls, git } = fakeGit((_cwd, args) => {
        if (args[0] === 'rev-parse') return ok(`${join(clone, '.git')}\n`);
        if (args[0] === 'worktree' && args[1] === 'list') {
          return ok(
            porcelain([
              { path: clone, branch: 'main' },
              { path, branch },
            ]),
          );
        }
        if (args[0] === 'for-each-ref') return ok(`${branch}\0${TIP}\nfoedrum/state\0${BASE}\n`);
        if (args[0] === 'worktree' && args[1] === 'remove') {
          rmSync(args[2] ?? '', { recursive: true });
          rmSync(join(clone, '.git', 'worktrees', 'implement1'), { recursive: true });
        }
        return undefined;
      });

      const report = await open(git).clean(ended);

      assert.deepEqual(calls, [
        [clone, 'rev-parse', '--path-format=absolute', '--git-common-dir'],
        [clone, 'worktree', 'list', '--porcelain', '-z'],
        // Against the record, never the repository the folder's own .git file names.
        [
          clone,
          `--git-dir=${join(clone, '.git', 'worktrees', 'implement1')}`,
          `--work-tree=${path}`,
          'status',
          '--porcelain',
        ],
        [
          clone,
          'for-each-ref',
          '--format=%(refname:lstrip=2)%00%(objectname)',
          'refs/heads/foedrum/',
        ],
        [clone, 'worktree', 'remove', path],
        [clone, 'update-ref', '-d', `refs/heads/${branch}`, TIP],
        [clone, 'config', '--remove-section', `branch.${branch}`],
      ]);
      assert.deepEqual(report, {
        done: [
          'removed worktree 12-1/implement/1',
          `deleted branch ${branch}`,
          'removed batch folder 12-1',
        ],
        kept: [],
        failed: [],
      });
      assert.equal(existsSync(join(root, '12-1')), false);
    });

    it('reports a worktree it could not remove, and keeps its branch', async () => {
      worktreeOnDisk(path, 'implement1');
      const { calls, git } = fakeGit((_cwd, args) => {
        if (args[0] === 'rev-parse') return ok(`${join(clone, '.git')}\n`);
        if (args[0] === 'worktree' && args[1] === 'list') return ok(porcelain([{ path, branch }]));
        if (args[0] === 'for-each-ref') return ok(`${branch}\0${TIP}\n`);
        if (args[0] === 'worktree' && args[1] === 'remove') return failed('fatal: busy\n');
        return undefined;
      });

      const report = await open(git).clean(ended);

      assert.deepEqual(report.failed, ['could not clean 12-1/implement/1: fatal: busy']);
      assert.ok(!calls.some(([, ...args]) => args[0] === 'update-ref'));
      assert.ok(existsSync(join(root, '12-1')));
    });

    it('never runs git by a .git file that names another repository, and keeps that folder', async () => {
      // A brewer can write its worktree's .git file; git would then read that repository's
      // configuration, core.fsmonitor included, and run what it names.
      worktreeOnDisk(path, 'implement1');
      writeFileSync(join(path, '.git'), 'gitdir: ./forged\n');
      let statusCalls = 0;
      const { git } = fakeGit((_cwd, args) => {
        if (args[0] === 'rev-parse') return ok(`${join(clone, '.git')}\n`);
        if (args[0] === 'worktree' && args[1] === 'list') return ok(porcelain([{ path, branch }]));
        if (args.includes('status')) statusCalls += 1;
        return undefined;
      });

      const report = await open(git).clean(ended);

      assert.deepEqual(report.kept, [
        'kept worktree 12-1/implement/1: its .git file does not point at its record under the clone',
      ]);
      assert.deepEqual(report.done, []);
      assert.equal(statusCalls, 0);
    });

    it('runs status with core.fsmonitor off', async () => {
      worktreeOnDisk(path, 'implement1');
      const statusOptions: (GitOptions | undefined)[] = [];
      const git: Git = async (_cwd, args, options) => {
        if (args.includes('status')) statusOptions.push(options);
        if (args[0] === 'rev-parse') return ok(`${join(clone, '.git')}\n`);
        if (args[0] === 'worktree' && args[1] === 'list') return ok(porcelain([{ path, branch }]));
        return ok();
      };

      await open(git).clean({ batches: new Map([['12-1', 'live' as const]]), leased: [] });

      assert.deepEqual(
        statusOptions.map((options) => options?.config?.['core.fsmonitor']),
        ['false'],
      );
    });

    it('goes on after an item it could not remove, and reports each failure', async () => {
      const review = join(root, '12-1', 'review', '1');
      const reviewBranch = 'foedrum/12-1/review/1';
      worktreeOnDisk(path, 'implement1');
      worktreeOnDisk(review, 'review1');
      const stray = 'foedrum/12-1/bottle';
      const { calls, git } = fakeGit((_cwd, args) => {
        if (args[0] === 'rev-parse') return ok(`${join(clone, '.git')}\n`);
        if (args[0] === 'worktree' && args[1] === 'list') {
          return ok(
            porcelain([
              { path, branch },
              { path: review, branch: reviewBranch },
            ]),
          );
        }
        if (args[0] === 'for-each-ref') {
          return ok(`${branch}\0${TIP}\n${reviewBranch}\0${TIP}\n${stray}\0${BASE}\n`);
        }
        if (args[0] === 'worktree' && args[1] === 'remove' && args[2] === path) {
          return failed('fatal: busy\n');
        }
        if (args[0] === 'update-ref' && args[2] === `refs/heads/${stray}`) {
          return failed('fatal: cannot lock ref\n');
        }
        return undefined;
      });

      const report = await open(git).clean(ended);

      assert.deepEqual(report.failed, [
        'could not clean 12-1/implement/1: fatal: busy',
        `could not clean branch ${stray}: git update-ref failed: fatal: cannot lock ref`,
      ]);
      assert.deepEqual(report.done, [
        'removed worktree 12-1/review/1',
        `deleted branch ${reviewBranch}`,
      ]);
      assert.ok(calls.some(([, ...args]) => args[0] === 'worktree' && args[2] === review));
    });

    it('knows its worktrees when the work root is reached through a link', async () => {
      // git lists worktrees by their real path; the work root here is a link to another folder.
      const real = join(dir.path, 'real-work');
      mkdirSync(real);
      symlinkSync(real, workRoot, 'junction');
      const realPath = join(
        realpathSync.native(real),
        'acme.app',
        'attempts',
        '12-1',
        'implement',
        '1',
      );
      worktreeOnDisk(realPath, 'implement1');
      writeFileSync(join(realPath, 'work.txt'), 'changed\n');
      const { calls, git } = fakeGit((_cwd, args) => {
        if (args[0] === 'rev-parse') return ok(`${join(clone, '.git')}\n`);
        if (args[0] === 'worktree' && args[1] === 'list') {
          return ok(porcelain([{ path: realPath, branch }]));
        }
        if (args.includes('status')) return ok('?? work.txt\n');
        return undefined;
      });

      const report = await open(git).clean(ended);

      // A worktree with changes, so it is kept, not removed as a folder git does not know.
      assert.deepEqual(report, {
        done: [],
        kept: ['kept worktree 12-1/implement/1: it has uncommitted or untracked changes'],
        failed: [],
      });
      assert.ok(existsSync(join(realPath, 'work.txt')));
      assert.ok(calls.some((call) => call.includes(`--work-tree=${realPath}`)));
    });

    it('removes a stale index.lock of a live batch worktree no attempt runs in', async () => {
      const record = worktreeOnDisk(path, 'implement1');
      const lock = join(record, 'index.lock');
      writeFileSync(lock, '');
      utimesSync(lock, new Date(0), new Date(0));
      const { git } = fakeGit((_cwd, args) => {
        if (args[0] === 'rev-parse') return ok(`${join(clone, '.git')}\n`);
        if (args[0] === 'worktree' && args[1] === 'list') return ok(porcelain([{ path, branch }]));
        if (args[0] === 'for-each-ref') return ok(`${branch}\0${TIP}\n`);
        return undefined;
      });
      const live = { batches: new Map([['12-1', 'live' as const]]), leased: [] };

      const report = await open(git, () => 120_000).clean(live);

      assert.deepEqual(report.done, ['removed a stale index.lock of worktree 12-1/implement/1']);
      assert.equal(existsSync(lock), false);
      assert.ok(existsSync(path));
    });

    it('removes a folder git does not know in an ended batch', async () => {
      mkdirSync(join(path, 'leftover'), { recursive: true });
      const { git } = fakeGit((_cwd, args) => {
        if (args[0] === 'rev-parse') return ok(`${join(clone, '.git')}\n`);
        if (args[0] === 'worktree' && args[1] === 'list')
          return ok(porcelain([{ path: clone, branch: 'main' }]));
        return undefined;
      });

      const report = await open(git).clean(ended);

      assert.deepEqual(report.done, [
        'removed folder 12-1/implement/1: git does not know it as a worktree',
        'removed batch folder 12-1',
      ]);
      assert.equal(existsSync(join(root, '12-1')), false);
    });

    it('throws when it cannot list the worktrees: a partial list would free what is in use', async () => {
      const { git } = fakeGit((_cwd, args) =>
        args[0] === 'worktree'
          ? failed()
          : args[0] === 'rev-parse'
            ? ok(`${join(clone, '.git')}\n`)
            : undefined,
      );
      await assert.rejects(open(git).clean(ended), /worktree list/);
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
