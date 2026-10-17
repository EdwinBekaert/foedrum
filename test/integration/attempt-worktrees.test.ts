// Real git for the attempt worktree manager's shell (ADR 0021, ADR 0029): a bare origin, a user
// clone with a branch of its own checked out and a worktree of its own, and a work root next to
// them. Every test checks that the user's clone is left as it was.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import type { EventStore } from '../../src/engine/event-store.ts';
import { openSqliteEventStore } from '../../src/engine/sqlite-event-store.ts';
import { removeTree } from '../../src/platform/remove.ts';
import type { AttemptRef, Claims } from '../../src/workspace/attempt-worktrees.ts';
import {
  ensureManagedClone,
  openAttemptWorktrees,
} from '../../src/workspace/attempt-worktrees-git.ts';
import { runGit } from '../../src/workspace/git.ts';
import { createBrewing } from '../helpers/brewing.ts';
import { behave, fakeBrewerRunner } from '../helpers/fake-brewer-runner.ts';
import { fakeRecipe, fakeRecipes } from '../helpers/fake-recipes.ts';
import { makeTempDir, type TempDir } from '../helpers/temp-dir.ts';
import { makeReadOnly } from './read-only.ts';

const git = (cwd: string, args: string[]): string =>
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=t@example.com', ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

const lines = (text: string): string[] => text.split('\n').filter((line) => line !== '');

// The first commit, made once for the file. Each test's origin is a bare copy of it, and the
// user's clone is a clone of that origin, on main and tracking it.
let seeds: TempDir;
let seed: string;
before(() => {
  seeds = makeTempDir('attempts-seed');
  seed = join(seeds.path, 'seed');
  git(seeds.path, ['init', '-q', '-b', 'main', seed]);
  writeFileSync(join(seed, 'readme.txt'), 'hello\n');
  git(seed, ['add', 'readme.txt']);
  git(seed, ['commit', '-q', '-m', 'Initial commit']);
});
after(() => removeTree(seeds.path));

const cloneSeed = (dir: string, origin: string, user: string): void => {
  git(dir, ['clone', '-q', '--bare', '--no-hardlinks', seed, origin]);
  git(dir, ['clone', '-q', origin, user]);
};

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
    cloneSeed(dir.path, origin, user);
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

// The engine's side (ADR 0037): the test driver gives each attempt a worktree of the user's clone,
// records it, and cleans up when the batch ends and when it starts again.
describe('the driver and attempt worktrees with real git', () => {
  let dir: TempDir;
  let user: string;
  let workRoot: string;
  let store: EventStore;
  let before: string;

  const snapshot = (): string =>
    JSON.stringify({
      head: git(user, ['symbolic-ref', 'HEAD']),
      status: git(user, ['status', '--porcelain']),
      branches: lines(git(user, ['for-each-ref', '--format=%(refname) %(objectname)'])).filter(
        // A fetch updates the remote-tracking refs (and origin/HEAD), as any fetch does.
        (line) => !line.startsWith('refs/heads/foedrum/') && !line.startsWith('refs/remotes/'),
      ),
    });
  const leftovers = () => ({
    branches: lines(
      git(user, ['for-each-ref', '--format=%(refname:lstrip=2)', 'refs/heads/foedrum/']),
    ),
    records: existsSync(join(user, '.git', 'worktrees'))
      ? readdirSync(join(user, '.git', 'worktrees'))
      : [],
  });

  beforeEach(() => {
    dir = makeTempDir('driver-worktrees');
    const origin = join(dir.path, 'origin.git');
    user = join(dir.path, 'user');
    workRoot = join(dir.path, 'work');
    cloneSeed(dir.path, origin, user);
    git(user, ['switch', '-q', '-c', 'topic']);
    // The user's HEAD is ahead of origin/main, so a worktree made at the base is told apart.
    writeFileSync(join(user, 'topic.txt'), 'topic\n');
    git(user, ['add', 'topic.txt']);
    git(user, ['commit', '-q', '-m', 'Topic']);
    store = openSqliteEventStore(':memory:');
    before = snapshot();
  });
  afterEach(async () => {
    store.close();
    assert.equal(snapshot(), before, "the user's clone changed");
    await removeTree(dir.path);
  });

  const recipes = fakeRecipes({ pint: fakeRecipe({ steps: ['plan', 'implement'] }) });
  const manager = () =>
    openAttemptWorktrees({ git: runGit, workRoot, repo: 'acme/app', clone: user });
  const driver = (worktrees: boolean) =>
    createBrewing({
      store,
      runner: fakeBrewerRunner({ plan: [behave.succeed()], implement: [behave.succeed()] }),
      recipes,
      clock: () => new Date('2026-10-16T12:00:00.000Z'),
      ...(worktrees
        ? { worktrees: { repo: 'acme/app', base: 'origin/main', manager: manager() } }
        : {}),
    });
  const brewOnTap = async (brewing: ReturnType<typeof createBrewing>) => {
    assert.ok(brewing.command({ kind: 'order', batchId: '12-1', order: { issue: 12 } }));
    const route = { kind: 'route', batchId: '12-1', recipe: 'pint', reason: 'label' } as const;
    assert.ok(brewing.command({ ...route, source: 'label' }));
    await brewing.drive();
    assert.equal(brewing.batch('12-1').lane.kind, 'on_tap');
  };

  it('records each attempt worktree, and leaves nothing behind once the batch is on tap', async () => {
    const brewing = driver(true);
    await brewing.start();
    await brewOnTap(brewing);

    const recorded = brewing
      .events()
      .flatMap((event) =>
        event.type === 'step.started' && event.worktree !== undefined ? [event.worktree] : [],
      );
    assert.deepEqual(
      recorded.map(({ repo, branch }) => [repo, branch]),
      [
        ['acme/app', 'foedrum/12-1/plan/1'],
        ['acme/app', 'foedrum/12-1/implement/1'],
      ],
    );
    const base = git(user, ['rev-parse', 'origin/main']).trim();
    assert.notEqual(git(user, ['rev-parse', 'HEAD']).trim(), base);
    assert.deepEqual(
      recorded.map(({ commit }) => commit),
      [base, base],
    );
    for (const [{ path }, step] of recorded.map(
      (worktree, i) => [worktree, ['plan', 'implement'][i]] as const,
    )) {
      assert.ok(path.endsWith(join('acme.app', 'attempts', '12-1', step ?? '', '1')), path);
    }
    assert.deepEqual(leftovers(), { branches: [], records: [] });
    assert.deepEqual(readdirSync(manager().root), []);
  });

  it('removes at its start what a driver that died before cleaning up left of an ended batch', async () => {
    // The batch went on tap, but the driver died before it cleaned up: its worktree is still there.
    await brewOnTap(driver(false));
    const left = await manager().create(
      { batchId: '12-1', stepId: 'plan', attempt: 1 },
      'origin/main',
    );
    assert.ok(existsSync(left.path));

    const { repair } = await driver(true).start();

    assert.deepEqual(repair.failed, []);
    assert.equal(existsSync(left.path), false);
    assert.deepEqual(leftovers(), { branches: [], records: [] });
  });
});
