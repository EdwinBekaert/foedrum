// Real git for the state branch's shell (ADR 0021, ADR 0024): a bare repository is the remote,
// and two clones of it are two machines, each with its own Brewery clone, work root and database.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import type { EventStore } from '../../src/engine/event-store.ts';
import { fold } from '../../src/engine/fold.ts';
import { openSqliteEventStore } from '../../src/engine/sqlite-event-store.ts';
import { isStepBoundary, StateBranchStopError } from '../../src/engine/state-branch.ts';
import { openStateBranch, type StateBranch } from '../../src/engine/state-branch-git.ts';
import { removeTree } from '../../src/platform/remove.ts';
import type { Event } from '../../src/schemas/events.ts';
import { runGit } from '../../src/workspace/git.ts';
import { makeTempDir, type TempDir } from '../helpers/temp-dir.ts';

const git = (cwd: string, args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

const at = (minute: number): string => new Date(Date.UTC(2026, 9, 15, 12, minute)).toISOString();

interface Machine {
  clone: string;
  database: string;
  worktree: string;
  store: EventStore;
  state: StateBranch;
}

describe('the state branch with real git', () => {
  let seeds: TempDir;
  let seed: string;
  let dir: TempDir;
  let origin: string;
  const stores: EventStore[] = [];

  // The Brewery's first commit, made once for the file; each test's remote is a bare copy of it.
  before(() => {
    seeds = makeTempDir('state-branch-seed');
    seed = join(seeds.path, 'seed');
    git(seeds.path, ['init', '-q', '-b', 'main', seed]);
    writeFileSync(join(seed, 'foedrum.jsonc'), '{}\n');
    git(seed, ['add', 'foedrum.jsonc']);
    git(seed, [
      '-c',
      'user.name=Test',
      '-c',
      'user.email=t@example.com',
      'commit',
      '-q',
      '-m',
      'Brewery',
    ]);
  });
  after(() => removeTree(seeds.path));

  beforeEach(() => {
    dir = makeTempDir('state-branch');
    origin = join(dir.path, 'origin.git');
    git(dir.path, ['clone', '-q', '--bare', '--no-hardlinks', seed, origin]);
  });
  afterEach(async () => {
    for (const store of stores.splice(0)) store.close();
    await removeTree(dir.path);
  });

  /** A machine: a clone of the Brewery with signing off, and a work root outside it. */
  const machine = (name: string): Machine => {
    const clone = join(dir.path, name, 'brewery');
    git(dir.path, ['clone', '-q', origin, clone]);
    for (const [key, value] of [
      ['user.name', `Engine ${name}`],
      ['user.email', `${name}@example.com`],
      ['commit.gpgsign', 'false'],
    ] as const) {
      git(clone, ['config', key, value]);
    }
    const database = join(dir.path, name, 'foedrum.db');
    const worktree = join(dir.path, name, 'work', 'state');
    const store = openSqliteEventStore(database);
    stores.push(store);
    return {
      clone,
      database,
      worktree,
      store,
      state: openStateBranch({ store, git: runGit, clone, worktree }),
    };
  };
  const reopen = (m: Machine): Machine => {
    const store = openSqliteEventStore(m.database);
    stores.push(store);
    return {
      ...m,
      store,
      state: openStateBranch({ store, git: runGit, clone: m.clone, worktree: m.worktree }),
    };
  };
  const close = (m: Machine): void => {
    m.store.close();
    stores.splice(stores.indexOf(m.store), 1);
  };

  /** Appends `event` and flushes when it ends a step, as the engine does. */
  const record = async (m: Machine, event: Event): Promise<void> => {
    const events = m.store.eventsAfter(0).map((stored) => stored.event);
    const before = fold(events);
    m.store.withTransaction((tx) => tx.append(event));
    if (isStepBoundary(event, before, fold([event], before))) {
      const result = await m.state.flush();
      assert.equal(result.kind, 'pushed', JSON.stringify(result));
    }
  };

  it('rebuilds a deleted database identically, also on another machine', async () => {
    const a = machine('a');
    // Hooks that would fail every commit and push: state commits skip them (ADR 0024).
    const hooks = join(a.clone, '.git', 'hooks');
    for (const hook of ['pre-commit', 'pre-push']) {
      writeFileSync(join(hooks, hook), '#!/bin/sh\nexit 1\n');
      chmodSync(join(hooks, hook), 0o755);
    }
    assert.deepEqual(await a.state.start(), { decision: 'ready' });
    // The signing check's test commit made its ref and deleted it again.
    assert.throws(
      () => git(a.clone, ['show-ref', '--verify', 'refs/foedrum/signing-check']),
      /not a valid ref/,
    );

    await record(a, {
      type: 'batch.ordered',
      batchId: 'b1',
      order: { issue: 6 },
      routeBy: '2026-12-31T00:00:00.000Z',
    });
    await record(a, {
      type: 'batch.ordered',
      batchId: 'b2',
      order: { issue: 7 },
      routeBy: '2026-12-31T00:00:00.000Z',
    });
    await record(a, {
      type: 'step.scheduled',
      batchId: 'b1',
      stepId: 'plan',
      attempt: 1,
      deadlineAt: at(30),
    });
    await record(a, { type: 'step.started', batchId: 'b1', stepId: 'plan', attempt: 1 });
    // Kept before its step.finished, as keepOutDocs does (ADR 0103).
    a.store.withTransaction((tx) =>
      tx.keepOutDoc({
        batchId: 'b1',
        stepId: 'plan',
        attempt: 1,
        text: '{ "status": "done" }\n# Plan\n',
      }),
    );
    await record(a, {
      type: 'step.finished',
      batchId: 'b1',
      stepId: 'plan',
      attempt: 1,
      outcome: { kind: 'succeeded', output: { plan: 'plan-1.md' } },
    });
    await record(a, {
      type: 'release.observed',
      repo: 'acme/lib-core',
      package: 'lib-core',
      version: '2.4.0',
    });
    await record(a, {
      type: 'step.scheduled',
      batchId: 'b2',
      stepId: 'brew',
      attempt: 1,
      deadlineAt: at(45),
    });
    a.store.withTransaction((tx) =>
      tx.recordEffect({ batchId: 'b2', stepId: 'brew', attempt: 1, effect: 'comment' }, { id: 9 }),
    );
    await record(a, {
      type: 'batch.waiting',
      batchId: 'b2',
      on: { kind: 'sibling', batchId: 'b1' },
      remindAt: at(50),
    });

    const now = new Date(at(59));
    const snapshot = (store: EventStore) => ({
      events: store.eventsAfter(0),
      state: fold(store.eventsAfter(0).map((stored) => stored.event)),
      due: store.batchesPastDeadline(now),
      effect: store.findEffect({ batchId: 'b2', stepId: 'brew', attempt: 1, effect: 'comment' }),
      pushed: store.pushedThrough()?.eventId,
    });
    const expected = snapshot(a.store);
    assert.equal(expected.pushed, 9);
    // The out doc went into the same commit as the step.finished event that refers to it.
    const added = git(origin, [
      'log',
      '--format=%s',
      '--diff-filter=A',
      'foedrum/state',
      '--',
      'batches/b1/plan-1.md',
    ]);
    assert.equal(added.trim(), 'Record events 4–5');

    close(a);
    for (const suffix of ['', '-wal', '-shm']) rmSync(`${a.database}${suffix}`, { force: true });

    const rebuilt = reopen(a);
    assert.deepEqual(await rebuilt.state.start(), { decision: 'restore' });
    assert.deepEqual(snapshot(rebuilt.store), expected);

    const b = machine('b');
    assert.deepEqual(await b.state.start(), { decision: 'restore' });
    assert.deepEqual(snapshot(b.store), expected);
    assert.equal(
      readFileSync(join(b.worktree, 'batches', 'b1', 'plan-1.md'), 'utf8'),
      '{ "status": "done" }\n# Plan\n',
    );

    // The user's checkout stays on main, untouched.
    assert.equal(git(a.clone, ['symbolic-ref', '--short', 'HEAD']).trim(), 'main');
    assert.equal(git(a.clone, ['status', '--porcelain']), '');
  });

  it('stops an engine when another engine pushed in between', async () => {
    const a = machine('a');
    await a.state.start();
    await record(a, {
      type: 'batch.ordered',
      batchId: 'b1',
      order: { issue: 6 },
      routeBy: '2026-12-31T00:00:00.000Z',
    });

    const b = machine('b');
    assert.deepEqual(await b.state.start(), { decision: 'restore' });
    await record(b, {
      type: 'batch.ordered',
      batchId: 'b2',
      order: { issue: 7 },
      routeBy: '2026-12-31T00:00:00.000Z',
    });
    const pushedByB = git(origin, ['rev-parse', 'foedrum/state']).trim();

    a.store.withTransaction((tx) =>
      tx.append({
        type: 'batch.ordered',
        batchId: 'b3',
        order: { issue: 8 },
        routeBy: '2026-12-31T00:00:00.000Z',
      }),
    );
    await assert.rejects(
      a.state.flush(),
      (error) => error instanceof StateBranchStopError && error.message.includes(pushedByB),
    );
    const localHead = git(a.worktree, ['rev-parse', 'HEAD']).trim();
    assert.notEqual(localHead, pushedByB);
    assert.equal(a.store.pushedThrough()?.eventId, 1);
    assert.equal(git(origin, ['rev-parse', 'foedrum/state']).trim(), pushedByB);

    // A restart refuses too, naming both heads.
    close(a);
    const restarted = reopen(a);
    await assert.rejects(
      restarted.state.start(),
      (error) =>
        error instanceof StateBranchStopError &&
        error.message.includes(localHead) &&
        error.message.includes(pushedByB),
    );

    // As the stop message says: move the database aside, and the next start rebuilds it.
    close(restarted);
    for (const suffix of ['', '-wal', '-shm']) {
      if (existsSync(`${a.database}${suffix}`)) {
        renameSync(`${a.database}${suffix}`, `${a.database}.aside${suffix}`);
      }
    }
    const recovered = reopen(a);
    assert.deepEqual(await recovered.state.start(), { decision: 'restore' });
    assert.deepEqual(recovered.store.eventsAfter(0), b.store.eventsAfter(0));
    assert.equal(git(a.worktree, ['rev-parse', 'HEAD']).trim(), pushedByB);
  });

  it("runs none of the clone's hooks, also those --no-verify does not skip", async () => {
    const a = machine('a');
    const marker = join(dir.path, 'post-commit-ran').replaceAll('\\', '/');
    const hook = join(a.clone, '.git', 'hooks', 'post-commit');
    writeFileSync(hook, `#!/bin/sh\necho ran > "${marker}"\n`);
    chmodSync(hook, 0o755);
    // The hook works for an ordinary commit in the clone.
    git(a.clone, ['commit', '-q', '--allow-empty', '-m', 'Check the hook']);
    assert.ok(existsSync(marker), 'the post-commit hook did not run for a plain commit');
    rmSync(marker);

    await a.state.start();
    await record(a, {
      type: 'batch.ordered',
      batchId: 'b1',
      order: { issue: 6 },
      routeBy: '2026-12-31T00:00:00.000Z',
    });

    assert.equal(a.store.pushedThrough()?.eventId, 1);
    assert.equal(existsSync(marker), false, 'a state commit ran the post-commit hook');
  });

  it('catches up a store that is behind with a fast-forward', async () => {
    const a = machine('a');
    await a.state.start();
    await record(a, {
      type: 'batch.ordered',
      batchId: 'b1',
      order: { issue: 6 },
      routeBy: '2026-12-31T00:00:00.000Z',
    });
    const b = machine('b');
    await b.state.start();
    await record(b, {
      type: 'batch.ordered',
      batchId: 'b2',
      order: { issue: 7 },
      routeBy: '2026-12-31T00:00:00.000Z',
    });

    close(a);
    const restarted = reopen(a);
    assert.deepEqual(await restarted.state.start(), { decision: 'restore' });
    assert.deepEqual(restarted.store.eventsAfter(0), b.store.eventsAfter(0));
    assert.equal(
      git(a.worktree, ['rev-parse', 'HEAD']).trim(),
      git(origin, ['rev-parse', 'foedrum/state']).trim(),
    );
  });

  it('reports a push that a remote hook refuses, keeps the marker, and does not stop', async () => {
    const a = machine('a');
    await a.state.start();
    await record(a, {
      type: 'batch.ordered',
      batchId: 'b1',
      order: { issue: 6 },
      routeBy: '2026-12-31T00:00:00.000Z',
    });
    const hook = join(origin, 'hooks', 'pre-receive');
    writeFileSync(hook, '#!/bin/sh\necho "state pushes are closed" >&2\nexit 1\n');
    chmodSync(hook, 0o755);

    a.store.withTransaction((tx) =>
      tx.append({
        type: 'batch.ordered',
        batchId: 'b2',
        order: { issue: 7 },
        routeBy: '2026-12-31T00:00:00.000Z',
      }),
    );
    const result = await a.state.flush();

    assert.equal(result.kind, 'failed', JSON.stringify(result));
    assert.equal(a.store.pushedThrough()?.eventId, 1);
  });

  it('refuses to start when the clone signs and signing cannot work, and leaves no ref', async () => {
    const a = machine('a');
    git(a.clone, ['config', 'commit.gpgsign', 'true']);
    git(a.clone, ['config', 'gpg.program', join(dir.path, 'no-such-gpg')]);
    await assert.rejects(
      a.state.start(),
      (error) => error instanceof StateBranchStopError && /commit\.gpgSign/.test(error.message),
    );
    assert.throws(
      () => git(a.clone, ['show-ref', '--verify', 'refs/foedrum/signing-check']),
      /not a valid ref/,
    );
  });

  it('refuses a remote branch that holds a symbolic link', async () => {
    // A commit on foedrum/state whose tree has batches/b1 as a link to a folder outside.
    const author = ['-c', 'user.name=Test', '-c', 'user.email=t@example.com'];
    const work = join(dir.path, 'work-clone');
    git(dir.path, ['clone', '-q', origin, work]);
    const blob = execFileSync('git', ['hash-object', '-w', '--stdin'], {
      cwd: work,
      input: '../../outside',
      encoding: 'utf8',
    }).trim();
    git(work, ['checkout', '-q', '--orphan', 'foedrum/state']);
    git(work, ['rm', '-rq', '--cached', '.']);
    git(work, ['update-index', '--add', '--cacheinfo', `120000,${blob},batches/b1`]);
    git(work, [...author, 'commit', '-q', '-m', 'Link out']);
    git(work, ['push', '-q', origin, 'foedrum/state']);

    const a = machine('a');
    await assert.rejects(
      a.state.start(),
      (error) => error instanceof StateBranchStopError && /batches\/b1/.test(error.message),
    );
    assert.equal(existsSync(a.worktree), false);
  });
});
