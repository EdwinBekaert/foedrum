// The attempt worktree cleanup in the engine (ADR 0029, ADR 0037): which batches an event ends,
// what each repository's manager is asked to clean and with which claims, and what a driver does
// at its start. The managers are fakes; the real one is tested in attempt-worktrees*.test.ts.

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { attemptKey } from '../../src/engine/attempt-key.ts';
import { startDriver } from '../../src/engine/driver-start.ts';
import type { EventStore, Lease } from '../../src/engine/event-store.ts';
import { fold, type State } from '../../src/engine/fold.ts';
import { openSqliteEventStore } from '../../src/engine/sqlite-event-store.ts';
import { createWorktreeCleanup, endedBatches } from '../../src/engine/worktree-cleanup.ts';
import type { Event } from '../../src/schemas/events.ts';
import { fakeLock } from '../helpers/fake-lock.ts';
import { fakeWorktrees } from '../helpers/fake-worktrees.ts';

const now = new Date('2026-10-16T12:00:00.000Z');
const later = new Date('2026-10-16T12:05:00.000Z');
const routeBy = '2026-10-16T13:00:00.000Z';
const pullRequest = 'https://github.com/acme/app/pull/7';
const by = { by: 'edwin', via: 'terminal' } as const;

const ordered = (batchId: string): Event => ({
  type: 'batch.ordered',
  batchId,
  order: { issue: 1 },
  routeBy,
});
const onTap = (batchId: string): Event => ({
  type: 'batch.on_tap',
  batchId,
  pullRequests: [pullRequest],
});
const cancelled = (batchId: string): Event => ({ type: 'batch.cancelled', batchId, ...by });

// b-live is Ordered, b-tap on tap, b-off cancelled.
const state: State = fold([
  ordered('b-live'),
  ordered('b-tap'),
  ordered('b-off'),
  onTap('b-tap'),
  cancelled('b-off'),
]);
const ref = { batchId: 'b-live', stepId: 'plan', attempt: 1 };
const lease = (owner: string): Lease => ({
  attemptKey: attemptKey.encode(ref),
  owner,
  expiresAt: later,
});

describe('endedBatches', () => {
  it('lists the batches the events put on tap or cancel, each once, in order', () => {
    assert.deepStrictEqual(
      endedBatches([ordered('b1'), cancelled('b2'), onTap('b1'), cancelled('b2'), ordered('b3')]),
      ['b2', 'b1'],
    );
  });

  it('lists nothing for events that end no batch', () => {
    assert.deepStrictEqual(endedBatches([ordered('b1')]), []);
  });
});

describe('createWorktreeCleanup', () => {
  it('repairs every repository over every batch, with the claims of the state and the leases', async () => {
    const app = fakeWorktrees({ root: 'app' });
    const lib = fakeWorktrees({ root: 'lib' });
    const cleanup = createWorktreeCleanup({
      worktrees: [app, lib],
      state: () => state,
      leases: () => [lease('cellar')],
    });

    const report = await cleanup.repair();

    const claims = {
      batches: new Map([
        ['b-live', 'live'],
        ['b-tap', 'ended'],
        ['b-off', 'ended'],
      ]),
      leased: [ref],
    };
    assert.deepStrictEqual(app.cleans(), [{ claims, scope: {} }]);
    assert.deepStrictEqual(lib.cleans(), [{ claims, scope: {} }]);
    assert.deepStrictEqual(report, {
      done: ['cleaned app every batch', 'cleaned lib every batch'],
      kept: [],
      failed: [],
    });
  });

  it("claims the out doc of each step of an ended batch, from the step's brewer (ADR 0081)", async () => {
    const app = fakeWorktrees();
    const withSteps = fold([
      ordered('b-tap'),
      { type: 'step.scheduled', batchId: 'b-tap', stepId: 'brew', attempt: 1, deadlineAt: routeBy },
      onTap('b-tap'),
    ]);
    const cleanup = createWorktreeCleanup({
      worktrees: [app],
      state: () => withSteps,
      leases: () => [],
      outDoc: ({ stepId }) => `${stepId}.md`,
    });

    await cleanup.batchEnded('b-tap');

    assert.deepStrictEqual(
      app.cleans().map(({ claims }) => claims.outDocs),
      [new Map([['b-tap/brew', 'brew.md']])],
    );
  });

  it('cleans an ended batch in every repository, and only that batch', async () => {
    const app = fakeWorktrees({ root: 'app' });
    const lib = fakeWorktrees({ root: 'lib' });
    const cleanup = createWorktreeCleanup({
      worktrees: [app, lib],
      state: () => state,
      leases: () => [],
    });

    const tapped = await cleanup.batchEnded('b-tap');
    await cleanup.batchEnded('b-off');

    assert.deepStrictEqual(
      app.cleans().map(({ scope }) => scope),
      [{ batchId: 'b-tap' }, { batchId: 'b-off' }],
    );
    assert.deepStrictEqual(
      lib.cleans().map(({ scope }) => scope),
      [{ batchId: 'b-tap' }, { batchId: 'b-off' }],
    );
    assert.deepStrictEqual(tapped.done, ['cleaned app b-tap', 'cleaned lib b-tap']);
  });

  it('cleans nothing for a batch that is still live or that the state does not know', async () => {
    const app = fakeWorktrees();
    const cleanup = createWorktreeCleanup({
      worktrees: [app],
      state: () => state,
      leases: () => [],
    });

    const report = await cleanup.batchEnded('b-live');
    await cleanup.batchEnded('b-unknown');

    assert.deepStrictEqual(app.calls, []);
    assert.deepStrictEqual(report, { done: [], kept: [], failed: [] });
  });

  it('goes on with the other repositories when one cannot be cleaned, and reports it', async () => {
    const app = fakeWorktrees({ root: 'app', cleanFails: 'git worktree list failed: boom' });
    const lib = fakeWorktrees({ root: 'lib' });
    const cleanup = createWorktreeCleanup({
      worktrees: [app, lib],
      state: () => state,
      leases: () => [],
    });

    const report = await cleanup.repair();

    assert.deepStrictEqual(report, {
      done: ['cleaned lib every batch'],
      kept: [],
      failed: ['could not clean app: git worktree list failed: boom'],
    });
  });
});

describe('startDriver', () => {
  let store: EventStore;
  beforeEach(() => {
    store = openSqliteEventStore(':memory:');
  });
  afterEach(() => store.close());

  it("expires its earlier run's leases first, so the repair claims only other drivers' attempts", async () => {
    const own = { ...lease('driver-1'), attemptKey: attemptKey.encode({ ...ref, attempt: 2 }) };
    store.withTransaction((tx) => {
      tx.putLease(own);
      tx.putLease(lease('cellar'));
    });
    const app = fakeWorktrees({ root: 'app' });
    const cleanup = createWorktreeCleanup({
      worktrees: [app],
      state: () => state,
      leases: () => store.currentLeases(now),
    });

    const started = await startDriver({ store, lock: fakeLock('driver-1'), now, cleanup });

    assert.deepStrictEqual(started.expired, [own.attemptKey]);
    assert.deepStrictEqual(
      app.cleans().map(({ claims, scope }) => [claims.leased, scope]),
      [[[ref], {}]],
    );
    assert.deepStrictEqual(started.repair.done, ['cleaned app every batch']);
  });

  it('refuses without the driver lock held, expiring and cleaning nothing', async () => {
    store.withTransaction((tx) => tx.putLease(lease('driver-1')));
    const app = fakeWorktrees();
    const cleanup = createWorktreeCleanup({
      worktrees: [app],
      state: () => state,
      leases: () => store.currentLeases(now),
    });
    const lock = fakeLock();
    lock.release();

    await assert.rejects(startDriver({ store, lock, now, cleanup }), /lock fake\.lock/);
    assert.deepStrictEqual(store.currentLeases(now), [lease('driver-1')]);
    assert.deepStrictEqual(app.calls, []);
  });
});
