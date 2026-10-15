import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, it } from 'node:test';
import { openAttemptWorktrees } from '../../src/workspace/attempt-worktrees-git.ts';
import type { Git, GitOptions } from '../../src/workspace/git.ts';
import {
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
