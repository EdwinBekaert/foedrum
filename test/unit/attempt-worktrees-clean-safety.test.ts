import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  realpathSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, it } from 'node:test';
import { openAttemptWorktrees } from '../../src/workspace/attempt-worktrees-git.ts';
import type { Git, GitOptions } from '../../src/workspace/git.ts';
import {
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
