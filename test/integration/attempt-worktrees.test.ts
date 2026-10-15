// Real git for the attempt worktree manager's shell (ADR 0021, ADR 0029): a bare origin, a user
// clone with a branch of its own checked out and a worktree of its own, and a work root next to
// them. Every test checks that the user's clone is left as it was.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { removeTree } from '../../src/platform/remove.ts';
import type { AttemptRef, Claims } from '../../src/workspace/attempt-worktrees.ts';
import {
  ensureManagedClone,
  openAttemptWorktrees,
} from '../../src/workspace/attempt-worktrees-git.ts';
import { runGit } from '../../src/workspace/git.ts';
import { makeTempDir, type TempDir } from '../helpers/temp-dir.ts';
import { makeReadOnly } from './read-only.ts';

const git = (cwd: string, args: string[]): string =>
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=t@example.com', ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

const lines = (text: string): string[] => text.split('\n').filter((line) => line !== '');

const attempt = (batchId: string, stepId = 'implement', n = 1): AttemptRef => ({
  batchId,
  stepId,
  attempt: n,
});
const claims = (batches: Record<string, 'live' | 'ended'>, leased: AttemptRef[] = []): Claims => ({
  batches: new Map(Object.entries(batches)),
  leased,
});

describe('attempt worktrees with real git', () => {
  let dir: TempDir;
  let origin: string;
  let user: string;
  let userWorktree: string;
  let workRoot: string;
  let before: string;

  // Everything of the user's clone that Foedrum must never change.
  const userSnapshot = (): string =>
    JSON.stringify({
      head: git(user, ['symbolic-ref', 'HEAD']),
      status: git(user, ['status', '--porcelain']),
      worktreeStatus: git(userWorktree, ['status', '--porcelain']),
      branches: lines(git(user, ['for-each-ref', '--format=%(refname) %(objectname)'])).filter(
        (line) => !line.startsWith('refs/heads/foedrum/') && !line.startsWith('refs/remotes/'),
      ),
      records: readdirSync(join(user, '.git', 'worktrees')).filter((name) => name === 'mine'),
    });

  beforeEach(() => {
    dir = makeTempDir('attempts');
    origin = join(dir.path, 'origin.git');
    user = join(dir.path, 'user');
    userWorktree = join(dir.path, 'mine');
    workRoot = join(dir.path, 'work');
    git(dir.path, ['init', '-q', '--bare', '-b', 'main', origin]);
    git(dir.path, ['init', '-q', '-b', 'main', user]);
    writeFileSync(join(user, 'readme.txt'), 'hello\n');
    git(user, ['add', 'readme.txt']);
    git(user, ['commit', '-q', '-m', 'Initial commit']);
    git(user, ['remote', 'add', 'origin', origin]);
    git(user, ['push', '-q', '-u', 'origin', 'main']);
    // The user works on a topic branch, with uncommitted changes, and has a worktree of their own.
    git(user, ['switch', '-q', '-c', 'topic']);
    writeFileSync(join(user, 'readme.txt'), 'changed\n');
    git(user, ['worktree', 'add', '-q', '-b', 'mine', userWorktree, 'main']);
    before = userSnapshot();
  });
  afterEach(async () => {
    assert.equal(userSnapshot(), before, "the user's clone changed");
    await removeTree(dir.path);
  });

  const open = (clone = user) =>
    openAttemptWorktrees({ git: runGit, workRoot, repo: 'acme/app', clone });
  const records = (commonDir = join(user, '.git')): string[] =>
    existsSync(join(commonDir, 'worktrees'))
      ? readdirSync(join(commonDir, 'worktrees')).filter((name) => name !== 'mine')
      : [];
  const foedrumBranches = (clone = user): string[] =>
    lines(git(clone, ['for-each-ref', '--format=%(refname:lstrip=2)', 'refs/heads/foedrum/']));
  const brew = (path: string): void => {
    writeFileSync(join(path, 'work.txt'), 'brewed\n');
    git(path, ['add', 'work.txt']);
    git(path, ['commit', '-q', '-m', 'Brew']);
  };

  it('creates a worktree per attempt and leaves nothing behind when the batch ends', async () => {
    const worktrees = open();

    const first = await worktrees.create(attempt('12-1'), 'origin/main');
    const second = await worktrees.create(attempt('12-1', 'review'), first.commit);
    brew(first.path);

    assert.equal(git(first.path, ['symbolic-ref', '--short', 'HEAD']).trim(), first.branch);
    assert.equal(first.commit, git(user, ['rev-parse', 'origin/main']).trim());
    assert.notEqual(first.path, second.path);

    const report = await worktrees.clean(claims({ '12-1': 'ended' }), { batchId: '12-1' });

    assert.deepEqual(report.failed, []);
    assert.deepEqual(foedrumBranches(), []);
    assert.deepEqual(records(), []);
    assert.deepEqual(readdirSync(worktrees.root), []);
  });

  it('keeps the worktrees of a Stuck batch and of a leased attempt', async () => {
    const worktrees = open();
    const stuck = await worktrees.create(attempt('12-1'), 'origin/main');
    const leased = await worktrees.create(attempt('13-1'), 'origin/main');

    await worktrees.clean(claims({ '12-1': 'live', '13-1': 'ended' }, [attempt('13-1')]));

    assert.ok(existsSync(join(stuck.path, '.git')));
    assert.ok(existsSync(join(leased.path, '.git')));
    assert.deepEqual(foedrumBranches().sort(), [stuck.branch, leased.branch]);
  });

  it('repairs after a crash: a removal that stopped part-way, and a worktree no batch claims', async () => {
    const worktrees = open();
    const halfRemoved = await worktrees.create(attempt('12-1'), 'origin/main');
    const unrecorded = await worktrees.create(attempt('14-1'), 'origin/main');
    const kept = await worktrees.create(attempt('13-1'), 'origin/main');
    brew(kept.path);
    // git worktree remove deletes the .git file first; a kill after that leaves the rest.
    rmSync(join(halfRemoved.path, '.git'));

    // 14-1 never got recorded (the engine died before its batch.ordered was pushed), so the
    // rebuilt state does not know it.
    const report = await worktrees.clean(claims({ '12-1': 'ended', '13-1': 'live' }));

    assert.deepEqual(report.failed, []);
    assert.equal(existsSync(halfRemoved.path), false);
    assert.equal(existsSync(unrecorded.path), false);
    // What the state records is not lost, and neither are the commits of the batch it does
    // not know: that branch stays and is reported.
    assert.ok(existsSync(join(kept.path, 'work.txt')));
    assert.deepEqual(foedrumBranches().sort(), [kept.branch, unrecorded.branch].sort());
    assert.ok(
      report.kept.includes(`kept branch ${unrecorded.branch}: no batch 14-1 in this Brewery`),
    );
    assert.equal(records().length, 1);
  });

  it('creates the worktree again when a crash left the same attempt half made', async () => {
    const worktrees = open();
    const made = await worktrees.create(attempt('12-1'), 'origin/main');

    const again = await worktrees.create(attempt('12-1'), 'origin/main');

    assert.deepEqual(again, made);
  });

  it('recreates the worktree of a finished attempt at its recorded commit', async () => {
    const worktrees = open();
    const made = await worktrees.create(attempt('12-1'), 'origin/main');
    brew(made.path);
    const recorded = git(made.path, ['rev-parse', 'HEAD']).trim();
    git(user, ['worktree', 'remove', made.path]);
    git(user, ['branch', '-q', '-D', made.branch]);

    const back = await worktrees.recreate(attempt('12-1'), recorded);

    assert.equal(back.path, made.path);
    assert.equal(git(back.path, ['rev-parse', 'HEAD']).trim(), recorded);
  });

  it('leaves a stale record outside the work root alone', async () => {
    const elsewhere = join(dir.path, 'elsewhere');
    git(user, ['worktree', 'add', '-q', '-b', 'elsewhere', elsewhere, 'main']);
    rmSync(elsewhere, { recursive: true, force: true });

    await open().clean(claims({}));

    assert.ok(records().includes('elsewhere'));
    git(user, ['worktree', 'remove', '--force', elsewhere]);
    git(user, ['branch', '-q', '-D', 'elsewhere']);
  });

  it('removes read-only folders and a stale index.lock', async () => {
    const worktrees = open();
    const readOnly = await worktrees.create(attempt('12-1'), 'origin/main');
    const live = await worktrees.create(attempt('13-1'), 'origin/main');
    makeReadOnly(join(readOnly.path, 'readme.txt'));
    const gitDir = git(live.path, ['rev-parse', '--absolute-git-dir']).trim();
    const lock = join(gitDir, 'index.lock');
    writeFileSync(lock, '');
    utimesSync(lock, new Date(0), new Date(0));

    const report = await worktrees.clean(claims({ '12-1': 'ended', '13-1': 'live' }));

    assert.deepEqual(report.failed, []);
    assert.equal(existsSync(readOnly.path), false);
    assert.equal(existsSync(lock), false);
    assert.ok(existsSync(join(live.path, '.git')));
  });

  it('makes worktrees from a managed bare partial clone that borrows from the user clone', async () => {
    const clone = await ensureManagedClone({
      git: runGit,
      workRoot,
      repo: 'acme/app',
      url: origin,
      reference: user,
    });
    assert.equal(git(clone, ['rev-parse', '--is-bare-repository']).trim(), 'true');
    const worktrees = open(clone);

    const made = await worktrees.create(attempt('12-1'), 'origin/main');
    assert.ok(existsSync(join(made.path, 'readme.txt')));
    await worktrees.clean(claims({ '12-1': 'ended' }));

    assert.deepEqual(foedrumBranches(clone), []);
    assert.deepEqual(records(clone), []);
  });
});
