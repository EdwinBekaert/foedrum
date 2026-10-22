import assert from 'node:assert/strict';
import {
  existsSync,
  lutimesSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { beforeEach, describe, it } from 'node:test';
import {
  type CleanReport,
  cleanOwnGitDirs,
  openAttemptWorktrees,
} from '../../src/workspace/attempt-worktrees-git.ts';
import type { Git } from '../../src/workspace/git.ts';
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
      own: { url: 'https://github.com/acme/app.git', root: join(workRoot, 'git-dirs') },
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
          // Nor the repository a submodule's .git file names.
          '--ignore-submodules=all',
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

    describe("the step's own out doc (ADR 0081)", () => {
      const withOutDoc = { ...ended, outDocs: new Map([['12-1/implement', 'brew.md']]) };
      // git status lists `status`; git worktree remove refuses while anything is untracked.
      const gitWith = (status: string) =>
        fakeGit((_cwd, args) => {
          if (args[0] === 'rev-parse') return ok(`${join(clone, '.git')}\n`);
          if (args[0] === 'worktree' && args[1] === 'list') {
            return ok(porcelain([{ path, branch }]));
          }
          if (args.includes('status')) return ok(status);
          if (args[0] === 'for-each-ref') return ok(`${branch}\0${TIP}\n`);
          if (args[0] === 'worktree' && args[1] === 'remove') {
            if (existsSync(join(path, 'brew.md')) || existsSync(join(path, 'notes.txt'))) {
              return failed(`fatal: '${path}' contains modified or untracked files\n`);
            }
            rmSync(args[2] ?? '', { recursive: true });
            rmSync(join(clone, '.git', 'worktrees', 'implement1'), { recursive: true });
          }
          return undefined;
        });

      it('removes a worktree whose only change is its out doc', async () => {
        worktreeOnDisk(path, 'implement1');
        writeFileSync(join(path, 'brew.md'), '---\n{ "status": "done" }\n---\n');
        const { calls, git } = gitWith('?? brew.md\n');

        const report = await open(git).clean(withOutDoc);

        assert.deepEqual(report, {
          done: [
            'removed worktree 12-1/implement/1',
            `deleted branch ${branch}`,
            'removed batch folder 12-1',
          ],
          kept: [],
          failed: [],
        });
        // Plain git worktree remove, never --force: git still refuses any other change.
        assert.ok(calls.some((call) => call.join(' ') === `${clone} worktree remove ${path}`));
        assert.equal(existsSync(join(root, '12-1')), false);
      });

      it('keeps a worktree with its out doc and another untracked file, and both files', async () => {
        worktreeOnDisk(path, 'implement1');
        writeFileSync(join(path, 'brew.md'), '---\n{ "status": "done" }\n---\n');
        writeFileSync(join(path, 'notes.txt'), 'work a brewer left\n');
        const { calls, git } = gitWith('?? brew.md\n?? notes.txt\n');

        const report = await open(git).clean(withOutDoc);

        assert.deepEqual(report.kept, [
          'kept worktree 12-1/implement/1: it has uncommitted or untracked changes',
        ]);
        assert.deepEqual(report.done, []);
        assert.ok(!calls.some(([, ...args]) => args[0] === 'worktree' && args[1] === 'remove'));
        assert.ok(existsSync(join(path, 'brew.md')));
        assert.ok(existsSync(join(path, 'notes.txt')));
      });

      it("keeps a worktree with an untracked file named as another step's out doc", async () => {
        worktreeOnDisk(path, 'implement1');
        writeFileSync(join(path, 'brew.md'), "another step's out doc\n");
        const { git } = gitWith('?? brew.md\n');
        const otherStep = { ...ended, outDocs: new Map([['12-1/review', 'brew.md']]) };

        const report = await open(git).clean(otherStep);

        assert.deepEqual(report.kept, [
          'kept worktree 12-1/implement/1: it has uncommitted or untracked changes',
        ]);
        assert.ok(existsSync(join(path, 'brew.md')));
      });

      it('removes the worktree when its out doc went since git listed it', async () => {
        worktreeOnDisk(path, 'implement1');
        const { git } = gitWith('?? brew.md\n');

        const report = await open(git).clean(withOutDoc);

        assert.deepEqual(report.failed, []);
        assert.ok(report.done.includes('removed worktree 12-1/implement/1'));
      });

      it('leaves an out doc that became a folder to git, which refuses the removal', async () => {
        worktreeOnDisk(path, 'implement1');
        mkdirSync(join(path, 'brew.md', 'inside'), { recursive: true });
        writeFileSync(join(path, 'brew.md', 'inside', 'work.txt'), 'kept\n');
        // git listed a file there when it read the status; a folder took its place since.
        const { git } = gitWith('?? brew.md\n');

        const report = await open(git).clean(withOutDoc);

        assert.equal(report.failed.length, 1);
        assert.match(report.failed[0] ?? '', /could not clean 12-1\/implement\/1: fatal:/);
        assert.ok(existsSync(join(path, 'brew.md', 'inside', 'work.txt')));
      });
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

    describe('the git directories of its own a stopped call left (ADR 0130)', () => {
      const uuid = '0b6f2c1e-3d4a-4f5b-8c6d-7e8f9a0b1c2d';
      const young = 'f1e2d3c4-b5a6-4978-8a6b-5c4d3e2f1a0b';
      // In seconds, as utimesSync takes them.
      const at = 1_800_000_000;
      const now = () => (at + 2 * 3600) * 1000;
      const noWorktrees = () =>
        fakeGit((_cwd, args) => {
          if (args[0] === 'rev-parse') return ok(`${join(clone, '.git')}\n`);
          if (args[0] === 'worktree' && args[1] === 'list') {
            return ok(porcelain([{ path: clone, branch: 'main' }]));
          }
          return undefined;
        });
      const aged = (path: string, seconds: number) => utimesSync(path, seconds, seconds);

      it('removes the old ones, keeps the young, and leaves everything else alone', async () => {
        const gitDirs = join(workRoot, 'git-dirs');
        mkdirSync(join(gitDirs, `${uuid}.git`, 'refs', 'heads'), { recursive: true });
        writeFileSync(join(gitDirs, `${uuid}.git`, 'HEAD'), 'ref: refs/heads/main\n');
        mkdirSync(join(gitDirs, `${young}.git`));
        mkdirSync(join(gitDirs, 'notes'));
        writeFileSync(join(gitDirs, `${young.replace('f1', 'a1')}.git`), 'a file\n');
        aged(join(gitDirs, `${uuid}.git`), at);
        aged(join(gitDirs, `${young}.git`), at + 2 * 3600 - 60);
        aged(join(gitDirs, 'notes'), at);
        aged(join(gitDirs, `${young.replace('f1', 'a1')}.git`), at);
        const { git } = noWorktrees();

        const report = await open(git, now).clean(ended);

        assert.deepEqual(report, {
          done: [`removed git directory ${uuid}.git: a stopped call left it`],
          kept: [],
          failed: [],
        });
        assert.equal(existsSync(join(gitDirs, `${uuid}.git`)), false);
        assert.ok(existsSync(join(gitDirs, `${young}.git`)));
        assert.ok(existsSync(join(gitDirs, 'notes')));
        assert.ok(existsSync(join(gitDirs, `${young.replace('f1', 'a1')}.git`)));
      });

      it('reports a root it cannot read, and cleans the worktrees still', async () => {
        mkdirSync(join(path, 'leftover'), { recursive: true });
        mkdirSync(workRoot, { recursive: true });
        writeFileSync(join(workRoot, 'git-dirs'), 'not a folder\n');
        const { git } = noWorktrees();

        const report = await open(git, now).clean(ended);

        assert.equal(report.failed.length, 1);
        assert.match(
          report.failed[0] ?? '',
          /^could not clean the git directories in .*git-dirs: /,
        );
        assert.ok(report.done.includes('removed batch folder 12-1'));
      });

      it('leaves a link named <uuid>.git alone, and what it points at', async () => {
        const gitDirs = join(workRoot, 'git-dirs');
        const target = join(dir.path, 'elsewhere');
        mkdirSync(target, { recursive: true });
        mkdirSync(gitDirs, { recursive: true });
        symlinkSync(target, join(gitDirs, `${uuid}.git`), 'junction');
        // The link and what it points at both older than the floor.
        lutimesSync(join(gitDirs, `${uuid}.git`), at, at);
        aged(target, at);
        const { git } = noWorktrees();

        const report = await open(git, now).clean(ended);

        assert.deepEqual(report.done, []);
        assert.deepEqual(report.failed, []);
        assert.ok(existsSync(join(gitDirs, `${uuid}.git`)));
        assert.ok(existsSync(target));
      });

      // Two old git directories in the root, and the report a cleanup of it fills.
      const twoOld = (): { gitDirs: string; report: CleanReport } => {
        const gitDirs = join(workRoot, 'git-dirs');
        for (const name of [uuid, young]) {
          mkdirSync(join(gitDirs, `${name}.git`), { recursive: true });
          aged(join(gitDirs, `${name}.git`), at);
        }
        return { gitDirs, report: { done: [], kept: [], failed: [] } };
      };
      const removeAll = async (path: string) => rmSync(path, { recursive: true });

      it('reports a git directory it cannot remove, and removes the others', async () => {
        const { gitDirs, report } = twoOld();
        const remove = async (path: string) => {
          if (path.endsWith(`${uuid}.git`)) throw new Error('EBUSY: resource busy or locked');
          await removeAll(path);
        };

        await cleanOwnGitDirs(gitDirs, now(), report, { lstat, remove });

        assert.deepEqual(report.failed, [
          `could not clean git directory ${uuid}.git: EBUSY: resource busy or locked`,
        ]);
        assert.deepEqual(report.done, [
          `removed git directory ${young}.git: a stopped call left it`,
        ]);
      });

      it('skips an entry gone before its lstat, as a running call removes its own', async () => {
        const { gitDirs, report } = twoOld();
        const gone = async (path: string) => {
          if (path.endsWith(`${young}.git`)) {
            await removeAll(path);
            throw Object.assign(new Error(`ENOENT: no such file or directory, lstat '${path}'`), {
              code: 'ENOENT',
            });
          }
          return lstat(path);
        };

        await cleanOwnGitDirs(gitDirs, now(), report, { lstat: gone, remove: removeAll });

        assert.deepEqual(report, {
          done: [`removed git directory ${uuid}.git: a stopped call left it`],
          kept: [],
          failed: [],
        });
      });

      it('reports an entry it cannot read, and removes the others', async () => {
        const { gitDirs, report } = twoOld();
        const denied = async (path: string) => {
          if (path.endsWith(`${young}.git`)) {
            throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
          }
          return lstat(path);
        };

        await cleanOwnGitDirs(gitDirs, now(), report, { lstat: denied, remove: removeAll });

        assert.deepEqual(report, {
          done: [`removed git directory ${uuid}.git: a stopped call left it`],
          kept: [],
          failed: [`could not clean git directory ${young}.git: EACCES: permission denied`],
        });
        assert.ok(existsSync(join(gitDirs, `${young}.git`)));
      });
    });
  });
});
