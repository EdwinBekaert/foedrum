// The driver (ADR 0019, ADR 0033, ADR 0037): its lock and start come before any work, it holds the
// lease of every batch it drives and renews it, skips the batches another driver holds, stops at
// the next step boundary when it loses one, and applies a batch's effects only while it holds it.
// An in-memory store, a runner the test ends by hand, and a second command log for the intake and
// the other writers.

import assert from 'node:assert/strict';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { type AttemptRef, attemptKey } from '../../src/engine/attempt-key.ts';
import { type BaseMerge, baseMergeKey, type WorktreeMerged } from '../../src/engine/base-merge.ts';
import { takeOver } from '../../src/engine/batch-leases.ts';
import type {
  AttemptEnd,
  AttemptLimits,
  AttemptStart,
  BrewerRunner,
} from '../../src/engine/brewer-runner.ts';
import { type CommandLog, createCommandLog } from '../../src/engine/command-log.ts';
import type { Ending } from '../../src/engine/decide.ts';
import {
  type Driver,
  type DriverActions,
  type DriverNotice,
  type DriverOptions,
  openDriver,
} from '../../src/engine/driver.ts';
import { DriverRunningError } from '../../src/engine/driver-lock.ts';
import { effectKey } from '../../src/engine/effect-key.ts';
import type { EffectTarget } from '../../src/engine/effects.ts';
import type { EffectKey, EventStore, EventStoreTransaction } from '../../src/engine/event-store.ts';
import { fold, type State } from '../../src/engine/fold.ts';
import { openSqliteEventStore } from '../../src/engine/sqlite-event-store.ts';
import type { Event } from '../../src/schemas/events.ts';
import { defaultLimits } from '../helpers/brewing.ts';
import { fakeLock } from '../helpers/fake-lock.ts';
import { fakeRecipe, fakeRecipes } from '../helpers/fake-recipes.ts';
import { FAKE_COMMIT, type FakeWorktrees, fakeWorktrees } from '../helpers/fake-worktrees.ts';

const minute = 60_000;
const t0 = new Date('2026-10-15T12:00:00.000Z');
const at = (minutes: number): Date => new Date(t0.getTime() + minutes * minute);
const recipes = fakeRecipes({
  pint: fakeRecipe({ steps: ['plan', 'implement'] }),
  half: fakeRecipe({ steps: ['plan'] }),
  ale: fakeRecipe({
    steps: ['plan', 'open'],
    actions: { open: 'openPullRequest' },
    pullRequests: [],
  }),
  // Its green check merges the base first (ADR 0164).
  nip: fakeRecipe({
    steps: ['implement', 'green', 'open'],
    actions: { open: 'openPullRequest' },
    merges: ['green'],
    pullRequests: [],
  }),
});
const succeeded: Ending = {
  kind: 'succeeded',
  output: { status: 'done', summary: 'Done', assumptions: [] },
};

/**
 * A runner whose attempts run until the test ends them; a stopped one ends cancelled, with
 * `stopped`'s report.
 */
const handRunner = (onStop: Partial<AttemptEnd> = {}) => {
  const running = new Map<string, (end: AttemptEnd) => void>();
  const failing = new Map<string, (error: Error) => void>();
  // The attempts whose end rejected: a broken runner may report them on, also after their stop.
  const broken = new Set<string>();
  const started: AttemptRef[] = [];
  const stopped: string[] = [];
  const runner: BrewerRunner = {
    start: ({ ref }: AttemptStart) => {
      started.push(ref);
      const key = attemptKey.encode(ref);
      const ended = new Promise<AttemptEnd>((resolve, reject) => {
        running.set(key, resolve);
        failing.set(key, reject);
      });
      return {
        ended,
        stop: () => {
          stopped.push(key);
          running.get(key)?.({ ...onStop, ending: { kind: 'cancelled' } });
          running.delete(key);
        },
      };
    },
    progress: (ref) =>
      running.has(attemptKey.encode(ref)) || broken.has(attemptKey.encode(ref))
        ? { lastProgressAt: t0, turnsWithoutProgress: 0 }
        : undefined,
  };
  /** Ends the running attempt `ref` with `ending`. */
  const end = (
    ref: AttemptRef,
    ending: Ending = succeeded,
    more: Partial<AttemptEnd> = {},
  ): void => {
    const key = attemptKey.encode(ref);
    const resolve = running.get(key);
    assert.ok(resolve, `${key} runs`);
    running.delete(key);
    resolve({ ...more, ending });
  };
  /**
   * Rejects the end of the running attempt `ref` with `error`: the runner itself broke. It still
   * reports the attempt's progress, also after its stop, as a broken runner may.
   */
  const reject = (ref: AttemptRef, error: Error): void => {
    const key = attemptKey.encode(ref);
    const fail = failing.get(key);
    assert.ok(fail && running.has(key), `${key} runs`);
    broken.add(key);
    fail(error);
  };
  return { runner, started, stopped, end, reject };
};

/** A code host that applies every effect it is asked to, counting each. */
const fakeHost = () => {
  const applied: string[] = [];
  const target: EffectTarget = {
    find: async (key) => (applied.includes(key) ? { result: { key } } : undefined),
    apply: async (key) => {
      applied.push(key);
      return { key };
    },
  };
  return { applied, target };
};

/** One comment per succeeded attempt of the batch, as the chaos harness has. */
const commentsDue = (state: State, batchId: string): EffectKey[] =>
  [...(state.batches.get(batchId)?.steps.values() ?? [])].flatMap((step) =>
    [...step.attempts.values()].flatMap((attempt) =>
      attempt.phase === 'finished' && attempt.outcome.kind === 'succeeded'
        ? [{ batchId, stepId: step.id, attempt: attempt.attempt, effect: 'comment' }]
        : [],
    ),
  );

const plan = (batchId: string, attempt = 1): AttemptRef => ({ batchId, stepId: 'plan', attempt });
const types = (store: EventStore, batchId: string): string[] =>
  store
    .eventsAfter(0)
    .map(({ event }) => event)
    .filter((event) => 'batchId' in event && event.batchId === batchId)
    .map((event: Event) =>
      'attempt' in event ? `${event.type} ${event.stepId}#${event.attempt}` : event.type,
    );

describe('openDriver', () => {
  let store: EventStore;
  let now: Date;
  let intake: CommandLog;
  const drivers: Driver[] = [];

  beforeEach(() => {
    store = openSqliteEventStore(':memory:');
    now = t0;
    intake = createCommandLog({ store, recipes });
  });
  afterEach(() => {
    for (const driver of drivers.splice(0)) driver.close();
    store.close();
  });

  /** Orders `batchId` and routes it to the pint recipe: plan#1 is scheduled. */
  const order = (batchId: string): void => {
    const issue = Number(batchId.slice(1));
    assert.equal(intake.issue({ kind: 'order', batchId, order: { issue } }, now).kind, 'accepted');
    const route = {
      kind: 'route',
      batchId,
      recipe: 'pint',
      reason: 'label',
      source: 'label',
    } as const;
    assert.equal(intake.issue(route, now).kind, 'accepted');
  };

  const open = async (options: Partial<DriverOptions> & { owner?: string } = {}) => {
    const { owner = 'cellar', ...rest } = options;
    const driver = await openDriver({
      store,
      runner: handRunner().runner,
      recipes,
      clock: () => now,
      lock: () => fakeLock(owner),
      takes: () => true,
      stateBranch: { flush: async () => ({ kind: 'unchanged' }) },
      limits: () => defaultLimits,
      ...rest,
    });
    drivers.push(driver);
    return driver;
  };
  const batchLease = (batchId: string) =>
    store.batchLeases(now).find((lease) => lease.batchId === batchId);
  /** Another driver's lease of `batchId`, until `until` minutes from t0. */
  const holdFor = (owner: string, batchId: string, until = 5) =>
    store.withTransaction((tx) => tx.putBatchLease({ batchId, owner, expiresAt: at(until) }));

  describe('progress (ADR 0174)', () => {
    it('passes through what its runner reports of an attempt, display fields included, and nothing for one the runner does not run', async () => {
      const shown = {
        lastProgressAt: t0,
        turnsWithoutProgress: 2,
        turn: 14,
        lastTool: { name: 'Edit', word: 'src/a.ts' },
        denied: true,
      };
      const runner: BrewerRunner = {
        ...handRunner().runner,
        progress: (ref) => (ref.batchId === 'b1' ? shown : undefined),
      };
      const driver = await open({ runner });
      assert.deepStrictEqual(driver.progress(plan('b1')), shown);
      assert.equal(driver.progress(plan('b2')), undefined);
    });
  });

  describe('start', () => {
    it("takes its lock, then expires its earlier run's leases before any work", async () => {
      const key = attemptKey.encode(plan('b1'));
      store.withTransaction((tx) =>
        tx.putLease({ attemptKey: key, owner: 'cellar', expiresAt: at(5) }),
      );
      const driver = await open();
      assert.deepStrictEqual(driver.started.expired, [key]);
      assert.deepStrictEqual(store.currentLeases(now), []);
      assert.equal(driver.owner, 'cellar');
    });

    it('starts nothing when its lock is refused', async () => {
      const key = attemptKey.encode(plan('b1'));
      store.withTransaction((tx) =>
        tx.putLease({ attemptKey: key, owner: 'cellar', expiresAt: at(5) }),
      );
      const refused = new DriverRunningError('cellar', 'drivers/cellar.lock', undefined);
      await assert.rejects(
        open({
          lock: () => {
            throw refused;
          },
        }),
        refused,
      );
      // The live leases of the driver that holds the lock stay.
      assert.equal(store.currentLeases(now).length, 1);
    });

    it('lets its lock go when the start fails', async () => {
      const lock = fakeLock('cellar');
      const broken: EventStore = {
        ...store,
        currentLeases: () => {
          throw new Error('the disk is gone');
        },
      };
      await assert.rejects(open({ store: broken, lock: () => lock }), /the disk is gone/);
      assert.equal(lock.held, false);
    });

    it('lets its lock go when it closes', async () => {
      const lock = fakeLock('cellar');
      const driver = await open({ lock: () => lock });
      driver.close();
      assert.equal(lock.held, false);
    });

    it('stops the runs it still has when it closes (ADR 0063)', async () => {
      const { runner, stopped } = handRunner();
      order('b1');
      const driver = await open({ runner });
      await driver.drive();
      driver.close();
      assert.deepStrictEqual(stopped, [attemptKey.encode(plan('b1'))]);
    });
  });

  describe('limits (#148)', () => {
    it("starts each attempt with the limits of that attempt, so they come from its batch's recipe", async () => {
      const asked: unknown[] = [];
      const given: AttemptLimits[] = [];
      const { runner } = handRunner();
      const limits = { ...defaultLimits, maxTurns: 7 };
      const driver = await open({
        runner: {
          ...runner,
          start: (attempt) => (given.push(attempt.limits), runner.start(attempt)),
        },
        limits: (attempt) => (asked.push(attempt), limits),
      });
      order('b1');
      order('b2');
      await driver.drive();
      assert.deepStrictEqual(asked, [plan('b1'), plan('b2')]);
      assert.deepStrictEqual(given, [limits, limits]);
    });
  });

  describe('batch leases', () => {
    it('holds the lease of a batch it brews, and lets it go once the batch is on tap', async () => {
      const { runner, end } = handRunner();
      order('b1');
      const driver = await open({ runner });
      await driver.drive();
      assert.deepStrictEqual(driver.held(), ['b1']);
      assert.equal(batchLease('b1')?.owner, 'cellar');
      end(plan('b1'));
      await driver.drive();
      end({ batchId: 'b1', stepId: 'implement', attempt: 1 });
      await driver.tick();
      assert.equal(driver.state().batches.get('b1')?.lane.kind, 'on_tap');
      assert.deepStrictEqual(driver.held(), []);
      assert.equal(batchLease('b1'), undefined);
    });

    it('renews the lease of every batch it holds on each tick', async () => {
      order('b1');
      const driver = await open();
      await driver.drive();
      assert.deepStrictEqual(batchLease('b1')?.expiresAt, at(5));
      now = at(4);
      await driver.tick();
      assert.deepStrictEqual(batchLease('b1')?.expiresAt, at(9));
    });

    it('renews the attempt lease of an attempt its runner runs on each tick, and none it does not', async () => {
      const { runner, end } = handRunner();
      order('b1');
      order('b2');
      const driver = await open({ runner });
      await driver.drive();
      // b2's plan#1 ends: its lease goes, and the tick has nothing of b2 to renew.
      end(plan('b2'), { kind: 'failed', retryable: false, reason: 'no' });
      await driver.drive();
      now = at(4);
      await driver.tick();
      assert.deepStrictEqual(
        store.currentLeases(now).map((lease) => [lease.attemptKey, lease.expiresAt]),
        [[attemptKey.encode(plan('b1')), at(9)]],
      );
    });

    it('stops a running attempt whose batch was cancelled, then lets the batch go', async () => {
      const { runner, stopped } = handRunner();
      order('b1');
      const driver = await open({ runner });
      await driver.drive();
      intake.issue({ kind: 'cancel', batchId: 'b1', by: 'ada', via: 'terminal' }, now);
      await driver.tick();
      assert.deepStrictEqual(stopped, [attemptKey.encode(plan('b1'))]);
      assert.deepStrictEqual(store.currentLeases(now), []);
      await driver.tick();
      assert.deepStrictEqual(driver.held(), []);
      assert.equal(batchLease('b1'), undefined);
    });

    it('skips a batch another driver holds, and takes it once that lease expired', async () => {
      const { runner, started } = handRunner();
      order('b1');
      holdFor('session-7', 'b1');
      const driver = await open({ runner });
      await driver.drive();
      assert.deepStrictEqual(started, []);
      assert.deepStrictEqual(driver.held(), []);
      now = at(5);
      await driver.tick();
      assert.deepStrictEqual(started, [plan('b1')]);
      assert.equal(batchLease('b1')?.owner, 'cellar');
    });

    it('takes only the free batches it is told to', async () => {
      const { runner, started } = handRunner();
      order('b1');
      order('b2');
      const driver = await open({ runner, owner: 'session-7', takes: (id) => id === 'b2' });
      await driver.drive();
      assert.deepStrictEqual(started, [plan('b2')]);
      assert.deepStrictEqual(driver.held(), ['b2']);
    });

    it('lets one of two drivers on a store drive a batch', async () => {
      const cellar = handRunner();
      const session = handRunner();
      order('b1');
      const first = await open({ runner: cellar.runner });
      const second = await open({ runner: session.runner, owner: 'session-7' });
      await Promise.all([first.drive(), second.drive()]);
      assert.equal(cellar.started.length + session.started.length, 1);
      assert.deepStrictEqual(
        types(store, 'b1').filter((type) => type.startsWith('step.started')),
        ['step.started plan#1'],
      );
      assert.deepStrictEqual([first.held(), second.held()], [['b1'], []]);
      assert.equal(batchLease('b1')?.owner, 'cellar');
      // plan#2 is scheduled and nothing else keeps the second driver from starting it: the lease does.
      intake.issue({ kind: 'lose', ...plan('b1'), reason: 'the lease of cellar expired' }, now);
      await second.drive();
      assert.deepStrictEqual(session.started, []);
    });

    it('stops at the next step boundary once another driver holds its batch', async () => {
      const { runner, started, stopped, end } = handRunner();
      order('b1');
      const driver = await open({ runner });
      await driver.drive();
      // An engineer's session takes the batch over while plan#1 runs.
      store.withTransaction((tx) =>
        tx.putBatchLease({ batchId: 'b1', owner: 'session-7', expiresAt: at(30) }),
      );
      now = at(1);
      await driver.tick();
      assert.deepStrictEqual(driver.held(), []);
      assert.deepStrictEqual(stopped, [], 'the running attempt goes on');
      end(plan('b1'));
      await driver.drive();
      assert.deepStrictEqual(types(store, 'b1').slice(-3), [
        'step.started plan#1',
        'step.finished plan#1',
        'step.scheduled implement#1',
      ]);
      assert.deepStrictEqual(started, [plan('b1')], 'it starts nothing more there');
    });

    it('renews no attempt lease of a run whose attempt another driver lost meanwhile', async () => {
      const { runner, end } = handRunner();
      const host = fakeHost();
      order('b1');
      order('b2');
      const driver = await open({ runner, effects: { due: commentsDue, target: host.target } });
      await driver.drive();
      // The driver stalled past its leases: another driver took b1 over and lost its plan#1.
      now = at(6);
      store.withTransaction((tx) =>
        tx.putBatchLease({ batchId: 'b1', owner: 'session-7', expiresAt: at(11) }),
      );
      const lose = { kind: 'lose', ...plan('b1'), reason: 'the attempt was lost' } as const;
      assert.equal(intake.issue(lose, now).kind, 'accepted');
      // It goes on with a drive and an effect pass, before any tick: b2's plan#1 has a comment due.
      end(plan('b2'));
      await driver.drive();
      await driver.applyEffects();
      assert.deepStrictEqual(host.applied, ['["b2","plan",1,"comment"]']);
      assert.deepStrictEqual(
        store.currentLeases(now).map((lease) => lease.attemptKey),
        [attemptKey.encode({ batchId: 'b2', stepId: 'implement', attempt: 1 })],
        "plan#1 of b1 keeps no live lease beside the new holder's",
      );
    });

    it('decides which attempt leases to renew on the events its heartbeat transaction sees', async () => {
      const { runner, end } = handRunner();
      const host = fakeHost();
      order('b1');
      order('b2');
      // Another driver's process may append as this driver's next transaction begins, after it
      // read the log.
      let beginning: (() => void) | undefined;
      const watched: EventStore = {
        ...store,
        withTransaction: (fn) => {
          const other = beginning;
          beginning = undefined;
          other?.();
          return store.withTransaction(fn);
        },
      };
      const effects = { due: commentsDue, target: host.target };
      const driver = await open({ store: watched, runner, effects });
      await driver.drive();
      end(plan('b2'));
      await driver.drive();
      // It stalled past its leases. As the heartbeat before b2's comment begins, another driver
      // takes b1 over and loses its plan#1.
      now = at(6);
      beginning = () => {
        store.withTransaction((tx) =>
          tx.putBatchLease({ batchId: 'b1', owner: 'session-7', expiresAt: at(11) }),
        );
        const lose = { kind: 'lose', ...plan('b1'), reason: 'the attempt was lost' } as const;
        assert.equal(intake.issue(lose, now).kind, 'accepted');
      };
      await driver.applyEffects();
      assert.deepStrictEqual(host.applied, ['["b2","plan",1,"comment"]']);
      assert.deepStrictEqual(
        store.currentLeases(now).map((lease) => lease.attemptKey),
        [attemptKey.encode({ batchId: 'b2', stepId: 'implement', attempt: 1 })],
        "plan#1 of b1 keeps no live lease beside the new holder's",
      );
    });

    it('renews no attempt lease of a run that Stuck abandoned while its stop takes time', async () => {
      // plan stalls after 10 minutes without progress, and a stopped run ends only when its
      // process is gone, later.
      const slow = fakeRecipes({ slow: fakeRecipe({ steps: ['plan'], stall: { minutes: 10 } }) });
      const stopped: string[] = [];
      const runner: BrewerRunner = {
        start: ({ ref }) => ({
          ended: new Promise<AttemptEnd>(() => {}),
          stop: () => stopped.push(attemptKey.encode(ref)),
        }),
        progress: () => ({ lastProgressAt: t0, turnsWithoutProgress: 0 }),
      };
      const host = fakeHost();
      // An effect of b1 comes due at minute 15.
      const note = { ...plan('b1'), effect: 'note' };
      const due = () => (now >= at(15) ? [note] : []);
      const log = createCommandLog({ store, recipes: slow });
      log.issue({ kind: 'order', batchId: 'b1', order: { issue: 1 } }, now);
      log.issue(
        { kind: 'route', batchId: 'b1', recipe: 'slow', reason: 'r', source: 'label' },
        now,
      );
      const driver = await open({ runner, recipes: slow, effects: { due, target: host.target } });
      await driver.drive();
      for (const minute of [4, 8, 11]) {
        now = at(minute);
        await driver.tick();
      }
      // At minute 11 Stuck abandoned plan#1 and the tick stopped its run, which runs on.
      assert.equal(driver.state().batches.get('b1')?.lane.kind, 'stuck');
      assert.deepStrictEqual(stopped, [attemptKey.encode(plan('b1'))]);
      now = at(15);
      await driver.applyEffects();
      assert.deepStrictEqual(host.applied, ['["b1","plan",1,"note"]']);
      assert.deepStrictEqual(
        store.currentLeases(at(17)).map((lease) => lease.attemptKey),
        [],
        'the lease of the abandoned plan#1 ends where the last tick before it left it',
      );
    });

    it('starts no attempt whose own lease another driver holds: one that lost the batch to a takeover was starting it (ADR 0124)', async () => {
      const { runner, started } = handRunner();
      order('b1');
      const key = attemptKey.encode(plan('b1'));
      store.withTransaction((tx) =>
        tx.putLease({ attemptKey: key, owner: 'session-7', expiresAt: at(3) }),
      );
      const driver = await open({ runner });
      await driver.drive();
      assert.deepStrictEqual(started, [], 'plan#1 waits');
      now = at(3);
      await driver.drive();
      assert.deepStrictEqual(started, [plan('b1')]);
    });

    it('records no start in a batch taken over after its claim, and loses the batch (ADR 0124)', async () => {
      const { runner, started } = handRunner();
      const notices: DriverNotice[] = [];
      order('b1');
      const holder = { batchId: 'b1', owner: 'session-7', expiresAt: at(5) };
      // Once armed, the second read of b1's lease (the start's, after the claim's) finds the
      // lease taken over in between.
      let armed = false;
      let reads = 0;
      const takenOver: EventStore = {
        ...store,
        withTransaction: (fn) =>
          store.withTransaction((tx) =>
            fn({
              ...tx,
              batchLease: (batchId) => {
                if (armed && ++reads === 2) tx.putBatchLease(holder);
                return tx.batchLease(batchId);
              },
            }),
          ),
      };
      const driver = await open({
        runner,
        store: takenOver,
        report: (notice) => notices.push(notice),
      });
      armed = true;
      await driver.drive();
      assert.deepStrictEqual(started, []);
      assert.ok(!store.eventsAfter(0).some(({ event }) => event.type === 'step.started'));
      assert.deepStrictEqual(
        notices.filter((notice) => notice.kind === 'batch_lost'),
        [{ kind: 'batch_lost', batchId: 'b1', holder }],
      );
      assert.deepStrictEqual(driver.held(), []);
    });

    describe('a retry while the run that Stuck abandoned still holds its lease (#150)', () => {
      // plan stalls after 10 minutes without progress; a stopped run ends only when the test
      // ends it, or never.
      const slow = fakeRecipes({ slow: fakeRecipe({ steps: ['plan'], stall: { minutes: 10 } }) });
      const leased = (when: Date): string[] =>
        store.currentLeases(when).map((lease) => lease.attemptKey);

      /** Drives b1 until Stuck abandoned plan#1 at minute 11, then retries it: plan#2 is scheduled. */
      const abandonAndRetry = async (options: Partial<DriverOptions> = {}) => {
        const ends = new Map<string, (end: AttemptEnd) => void>();
        const started: string[] = [];
        const runner: BrewerRunner = {
          start: ({ ref }) => {
            const key = attemptKey.encode(ref);
            started.push(key);
            return {
              ended: new Promise<AttemptEnd>((resolve) => ends.set(key, resolve)),
              stop: () => {},
            };
          },
          progress: () => ({ lastProgressAt: t0, turnsWithoutProgress: 0 }),
        };
        const log = createCommandLog({ store, recipes: slow });
        log.issue({ kind: 'order', batchId: 'b1', order: { issue: 1 } }, now);
        log.issue(
          { kind: 'route', batchId: 'b1', recipe: 'slow', reason: 'r', source: 'label' },
          now,
        );
        const driver = await open({ runner, recipes: slow, ...options });
        await driver.drive();
        for (const minute of [4, 8, 11]) {
          now = at(minute);
          await driver.tick();
        }
        assert.equal(driver.state().batches.get('b1')?.lane.kind, 'stuck');
        const retry = { kind: 'retry', batchId: 'b1', by: 'octocat', via: 'terminal' } as const;
        assert.equal(log.issue(retry, now).kind, 'accepted');
        return { driver, started, ends };
      };

      it('starts the new attempt only once the lease of the abandoned one expired', async () => {
        const { driver, started } = await abandonAndRetry();
        await driver.drive();
        assert.deepStrictEqual(started, [attemptKey.encode(plan('b1'))], 'plan#2 waits');
        assert.deepStrictEqual(leased(now), [attemptKey.encode(plan('b1'))]);
        // The tick at minute 11 renewed plan#1's lease until minute 16, and nothing renews it now.
        now = at(16);
        await driver.tick();
        assert.deepStrictEqual(started, [plan('b1'), plan('b1', 2)].map(attemptKey.encode));
        assert.deepStrictEqual(leased(now), [attemptKey.encode(plan('b1', 2))]);
      });

      it('says once that the new attempt waits for the lease, and not after it started (#155)', async () => {
        const notices: DriverNotice[] = [];
        const { driver, started } = await abandonAndRetry({
          report: (notice) => notices.push(notice),
        });
        const waits = () => notices.filter((notice) => notice.kind === 'waiting_for_lease');
        await driver.drive();
        await driver.drive();
        now = at(13);
        await driver.tick();
        assert.deepStrictEqual(waits(), [
          {
            kind: 'waiting_for_lease',
            ref: plan('b1', 2),
            waitsFor: plan('b1'),
            expiresAt: at(16),
          },
        ]);
        now = at(16);
        await driver.tick();
        assert.deepStrictEqual(started, [plan('b1'), plan('b1', 2)].map(attemptKey.encode));
        now = at(17);
        await driver.tick();
        assert.equal(waits().length, 1, 'nothing more once plan#2 started');
      });

      it('starts the new attempt as soon as the abandoned run ended', async () => {
        const { driver, started, ends } = await abandonAndRetry();
        await driver.drive();
        assert.deepStrictEqual(started, [attemptKey.encode(plan('b1'))], 'plan#2 waits');
        now = at(12);
        ends.get(attemptKey.encode(plan('b1')))?.({ ending: { kind: 'cancelled' } });
        await driver.drive();
        assert.deepStrictEqual(started, [plan('b1'), plan('b1', 2)].map(attemptKey.encode));
        assert.deepStrictEqual(leased(now), [attemptKey.encode(plan('b1', 2))]);
      });

      it('waits for no lease of another batch or another step', async () => {
        const { driver, started, ends } = await abandonAndRetry();
        now = at(12);
        ends.get(attemptKey.encode(plan('b1')))?.({ ending: { kind: 'cancelled' } });
        const others = [plan('b2'), { batchId: 'b1', stepId: 'implement', attempt: 1 }];
        store.withTransaction((tx) => {
          for (const ref of others) {
            tx.putLease({
              attemptKey: attemptKey.encode(ref),
              owner: 'session-7',
              expiresAt: at(30),
            });
          }
        });
        await driver.drive();
        assert.deepStrictEqual(started, [plan('b1'), plan('b1', 2)].map(attemptKey.encode));
      });

      it('lets the deadline of the waiting attempt pass when it is shorter than the lease', async () => {
        // A two-hour lease: the tick at minute 11 renewed plan#1's lease until minute 131, past
        // plan#2's deadline at minute 71.
        const { driver, started } = await abandonAndRetry({ leaseMs: 120 * minute });
        await driver.drive();
        now = at(72);
        await driver.tick();
        const lane = driver.state().batches.get('b1')?.lane;
        assert.equal(lane?.kind, 'stuck');
        assert.deepStrictEqual(lane.reason, {
          kind: 'deadline_passed',
          stepId: 'plan',
          deadlineAt: at(71).toISOString(),
        });
        assert.deepStrictEqual(started, [attemptKey.encode(plan('b1'))], 'plan#2 never started');
      });
    });

    it('reports a batch it lost to another driver', async () => {
      order('b1');
      const notices: unknown[] = [];
      const driver = await open({ report: (notice) => notices.push(notice) });
      await driver.drive();
      const holder = { batchId: 'b1', owner: 'session-7', expiresAt: at(30) };
      store.withTransaction((tx) => tx.putBatchLease(holder));
      await driver.tick();
      assert.deepStrictEqual(notices, [{ kind: 'batch_lost', batchId: 'b1', holder }]);
    });

    it('drives on the batches its owner held when it starts again', async () => {
      const first = handRunner();
      order('b1');
      const before = await open({ runner: first.runner });
      await before.drive();
      before.close();
      drivers.splice(0);
      // The process died with plan#1 running; the same owner starts again, taking nothing new.
      const second = handRunner();
      const after = await open({ runner: second.runner, takes: () => false });
      assert.deepStrictEqual(after.held(), ['b1']);
      await after.tick();
      assert.deepStrictEqual(second.started, [plan('b1', 2)]);
    });

    it('drives on only the batches drivesOn keeps of those its owner held, and lets the others lapse (ADR 0123)', async () => {
      order('b1');
      order('b2');
      const before = await open({ owner: 'session-7' });
      await before.drive();
      before.close();
      drivers.splice(0);
      const left = batchLease('b1')?.expiresAt;
      // An interactive driver for b2 alone: b1, which its owner left, is not driven or renewed.
      const second = handRunner();
      const after = await open({
        owner: 'session-7',
        runner: second.runner,
        takes: (id) => id === 'b2',
        drivesOn: () => false,
      });
      assert.deepStrictEqual(after.held(), []);
      now = at(1);
      await after.tick();
      assert.deepStrictEqual(after.held(), ['b2']);
      assert.deepStrictEqual(batchLease('b1')?.expiresAt, left);
      assert.ok(second.started.every(({ batchId }) => batchId === 'b2'));
    });
  });

  describe('attempt worktrees (ADR 0037)', () => {
    const worktreesOf = (manager: FakeWorktrees) => ({
      worktrees: [{ repo: 'acme/app', base: 'origin/main', manager }],
    });

    it('records the worktree of each attempt, and cleans them once the batch ended', async () => {
      const { runner, end } = handRunner();
      const manager = fakeWorktrees();
      const notices: DriverNotice[] = [];
      order('b1');
      const driver = await open({
        runner,
        ...worktreesOf(manager),
        report: (notice) => notices.push(notice),
      });
      await driver.drive();
      const start = store.eventsAfter(0).at(-1)?.event;
      assert.equal(start?.type === 'step.started' && start.worktree?.commit, FAKE_COMMIT);
      end(plan('b1'));
      await driver.drive();
      end({ batchId: 'b1', stepId: 'implement', attempt: 1 });
      await driver.drive();
      assert.deepStrictEqual(
        manager.cleans().map(({ scope }) => scope),
        [{}, { batchId: 'b1' }],
      );
      assert.deepStrictEqual(
        notices.map((notice) => notice.kind),
        ['cleaned'],
      );
    });

    it('makes no worktree of an attempt another driver leased after the pass read its leases (ADR 0124)', async () => {
      const { runner, started } = handRunner();
      const manager = fakeWorktrees();
      order('b1');
      const key = attemptKey.encode(plan('b1'));
      const other = { attemptKey: key, owner: 'session-7', expiresAt: at(5) };
      // Once armed, the first transaction of the drive (the claim) ends with session-7, which lost
      // the batch to a takeover, leasing plan#1 to start it.
      let armed = false;
      const late: EventStore = {
        ...store,
        withTransaction: (fn) => {
          const result = store.withTransaction(fn);
          if (armed) {
            armed = false;
            store.withTransaction((tx) => tx.putLease(other));
          }
          return result;
        },
      };
      const driver = await open({ runner, store: late, ...worktreesOf(manager) });
      armed = true;
      await driver.drive();
      assert.deepStrictEqual(started, []);
      assert.deepStrictEqual(
        manager.calls.filter((call) => call.kind === 'create'),
        [],
      );
      assert.deepStrictEqual(store.currentLeases(now), [other]);
    });

    it("keeps another driver's lease of an attempt whose worktree it could not make (ADR 0124)", async () => {
      const { runner } = handRunner();
      const key = attemptKey.encode(plan('b1'));
      const other = { attemptKey: key, owner: 'session-7', expiresAt: at(5) };
      // While the first worktree is made, another driver leases the attempt; then the make fails.
      let creates = 0;
      const manager: FakeWorktrees = {
        ...fakeWorktrees(),
        create: async () => {
          if (creates++ === 0) store.withTransaction((tx) => tx.putLease(other));
          throw new Error('the folder is in the way');
        },
      };
      order('b1');
      const driver = await open({ runner, ...worktreesOf(manager) });
      await driver.drive();
      assert.deepStrictEqual(store.currentLeases(now), [other]);
    });

    it('gives the cleanup the out doc of each step of the ended batch (ADR 0081)', async () => {
      const { runner, end } = handRunner();
      const manager = fakeWorktrees();
      order('b1');
      const driver = await open({
        runner,
        ...worktreesOf(manager),
        outDoc: ({ stepId }) => `${stepId}.md`,
      });
      await driver.drive();
      end(plan('b1'));
      await driver.drive();
      end({ batchId: 'b1', stepId: 'implement', attempt: 1 });
      await driver.drive();
      assert.deepStrictEqual(
        manager.cleans().at(-1)?.claims.outDocs,
        new Map([
          ['b1/plan', 'plan.md'],
          ['b1/implement', 'implement.md'],
        ]),
      );
    });

    it("starts each attempt's worktree at the task tree: the base, then the latest success's branch (ADR 0066)", async () => {
      const { runner, end } = handRunner();
      const manager = fakeWorktrees();
      order('b1');
      const driver = await open({ runner, ...worktreesOf(manager) });
      await driver.drive();
      end(plan('b1'));
      await driver.drive();
      const implement = (attempt: number) => ({ batchId: 'b1', stepId: 'implement', attempt });
      end(implement(1), { kind: 'failed', retryable: true, reason: 'tests fail' });
      await driver.drive();
      assert.deepStrictEqual(
        manager.calls.flatMap((call) =>
          call.kind === 'create' ? [`${call.ref.stepId}#${call.ref.attempt} ${call.base}`] : [],
        ),
        [
          'plan#1 origin/main',
          'implement#1 refs/heads/foedrum/b1/plan/1',
          // A retry starts where the failed attempt started.
          'implement#2 refs/heads/foedrum/b1/plan/1',
        ],
      );
    });

    describe('after a rewind (ADR 0066)', () => {
      const implement = (attempt: number) => ({ batchId: 'b1', stepId: 'implement', attempt });
      const sha = 'd'.repeat(40);
      /** Brews plan, gets implement#1 Stuck, and rewinds to implement with `shas`. */
      const rewindTo = async (shas: Record<string, string>) => {
        const { runner, end } = handRunner();
        const manager = fakeWorktrees();
        order('b1');
        const driver = await open({ runner, ...worktreesOf(manager) });
        await driver.drive();
        end(plan('b1'));
        await driver.drive();
        end(implement(1), { kind: 'failed', retryable: false, reason: 'tests fail' });
        await driver.drive();
        assert.equal(driver.state().batches.get('b1')?.lane.kind, 'stuck');
        const rewind = { kind: 'rewind', batchId: 'b1', toStepId: 'implement', shas } as const;
        const by = { by: 'octocat', via: 'terminal' } as const;
        assert.equal(intake.issue({ ...rewind, ...by }, now).kind, 'accepted');
        await driver.drive();
        const creates = manager.calls.flatMap((call) =>
          call.kind === 'create' ? [`${call.ref.stepId}#${call.ref.attempt} ${call.base}`] : [],
        );
        return { creates, events: store.eventsAfter(0).map(({ event }) => event) };
      };

      it("starts the next attempt at the rewind's commit of the batch's repository", async () => {
        const { creates } = await rewindTo({ 'acme/app': sha });
        assert.deepStrictEqual(creates.at(-1), `implement#2 ${sha}`);
      });

      it('fails the attempt retryably, making no worktree, when the rewind names no commit of it', async () => {
        const { creates, events } = await rewindTo({ 'acme/lib': sha });
        assert.equal(creates.length, 2, 'no worktree for implement#2');
        const finished = events.find(
          (event) =>
            event.type === 'step.finished' && event.stepId === 'implement' && event.attempt === 2,
        );
        assert.deepStrictEqual(finished?.type === 'step.finished' && finished.outcome, {
          kind: 'failed',
          retryable: true,
          reason:
            'the attempt could not get its worktree: the rewind of batch b1 names no commit of acme/app',
        });
      });
    });

    it('fails an attempt that cannot get its worktree retryably, and lets its lease go', async () => {
      const { runner, started } = handRunner();
      order('b1');
      const manager = fakeWorktrees({
        refuse: (ref) => (ref.attempt === 1 ? 'the worktree is in the way' : undefined),
      });
      const driver = await open({ runner, ...worktreesOf(manager) });
      await driver.drive();
      assert.deepStrictEqual(types(store, 'b1').slice(-4), [
        'step.started plan#1',
        'step.finished plan#1',
        'step.scheduled plan#2',
        'step.started plan#2',
      ]);
      assert.deepStrictEqual(started, [plan('b1', 2)]);
      assert.deepStrictEqual(
        store.currentLeases(now).map((lease) => lease.attemptKey),
        [attemptKey.encode(plan('b1', 2))],
      );
    });

    it('lets the lease go when the batch was cancelled while its worktree was made', async () => {
      const { runner, started } = handRunner();
      order('b1');
      const manager = fakeWorktrees();
      const create = manager.create.bind(manager);
      manager.create = async (ref, base) => {
        intake.issue({ kind: 'cancel', batchId: 'b1', by: 'ada', via: 'terminal' }, now);
        return create(ref, base);
      };
      const driver = await open({ runner, ...worktreesOf(manager) });
      await driver.drive();
      assert.deepStrictEqual(started, []);
      assert.deepStrictEqual(store.currentLeases(now), []);
    });

    it('cleans a cancelled batch again once the lease of a run that never ended expired (#144)', async () => {
      // The run's process died with the runner: its stop ends nothing, and it reports no progress,
      // so its lease is not renewed.
      const runner: BrewerRunner = {
        start: () => ({ ended: new Promise<AttemptEnd>(() => {}), stop: () => {} }),
        progress: () => undefined,
      };
      const manager = fakeWorktrees();
      order('b1');
      const driver = await open({ runner, ...worktreesOf(manager) });
      await driver.drive();
      intake.issue({ kind: 'cancel', batchId: 'b1', by: 'ada', via: 'terminal' }, now);
      // Cleaned while plan#1's lease is alive: the manager keeps its worktree.
      await driver.tick();
      const scopes = () => manager.cleans().map(({ scope }) => scope);
      assert.deepStrictEqual(scopes(), [{}, { batchId: 'b1' }]);
      // Not again while the lease is alive.
      now = at(2);
      await driver.tick();
      assert.deepStrictEqual(scopes(), [{}, { batchId: 'b1' }], 'while the lease is alive');
      now = at(6);
      await driver.tick();
      assert.deepStrictEqual(scopes(), [{}, { batchId: 'b1' }, { batchId: 'b1' }]);
      // The first cleanup kept plan#1's worktree under its lease; the second one claims it no more.
      const leased = () => manager.cleans().map(({ claims }) => claims.leased);
      assert.deepStrictEqual(leased().slice(1), [[plan('b1')], []]);
      now = at(7);
      await driver.tick();
      assert.deepStrictEqual(scopes(), [{}, { batchId: 'b1' }, { batchId: 'b1' }], 'once');
    });

    it('cleans it again also when the lease expired while the first cleanup ran (#144)', async () => {
      const runner: BrewerRunner = {
        start: () => ({ ended: new Promise<AttemptEnd>(() => {}), stop: () => {} }),
        progress: () => undefined,
      };
      const manager = fakeWorktrees();
      const clean = manager.clean.bind(manager);
      // The batch's cleanup reads the claims while plan#1's lease is alive, and its git steps
      // take until that lease has expired.
      manager.clean = async (claims, scope) => {
        const report = await clean(claims, scope);
        if (scope?.batchId !== undefined) now = at(6);
        return report;
      };
      order('b1');
      const driver = await open({ runner, ...worktreesOf(manager) });
      await driver.drive();
      intake.issue({ kind: 'cancel', batchId: 'b1', by: 'ada', via: 'terminal' }, now);
      await driver.tick();
      now = at(7);
      await driver.tick();
      assert.deepStrictEqual(
        manager.cleans().map(({ scope }) => scope),
        [{}, { batchId: 'b1' }, { batchId: 'b1' }],
      );
      assert.deepStrictEqual(
        manager.cleans().map(({ claims }) => claims.leased),
        [[], [plan('b1')], []],
        'the second cleanup claims the worktree no more',
      );
    });
  });

  describe('the merge of the base before the last check (ADR 0164)', () => {
    const BASE = 'b'.repeat(40);
    const MERGED = 'c'.repeat(40);
    const implement = { batchId: 'b1', stepId: 'implement', attempt: 1 };
    const green = { batchId: 'b1', stepId: 'green', attempt: 1 };
    /** A merge whose base is at BASE, and whose worktree merges as `merges` says. */
    const fakeMerge = (
      merges: () => WorktreeMerged = () => ({ kind: 'merged', commit: MERGED }),
    ) => {
      const calls: string[] = [];
      let head = FAKE_COMMIT;
      let fetches: () => string = () => BASE;
      const merge: BaseMerge = {
        base: 'main',
        push: {
          baseTip: async (base) => {
            calls.push(`fetch ${base}`);
            return fetches();
          },
          isAncestor: async (commit, of) => commit === of,
        },
        worktree: {
          head: async () => head,
          parents: async (_path, commit) => (commit === MERGED ? [FAKE_COMMIT, BASE] : []),
          abort: async () => {
            calls.push('abort');
          },
          merge: async (path, commit, message) => {
            calls.push(`merge ${commit} into ${path}: ${message}`);
            const merged = merges();
            if (merged.kind === 'merged') head = merged.commit;
            return merged;
          },
        },
      };
      return {
        merge,
        calls,
        failFetch: (message: string) => {
          fetches = () => {
            throw new Error(message);
          };
        },
      };
    };
    const orderNip = (): void => {
      intake.issue({ kind: 'order', batchId: 'b1', order: { issue: 1 } }, now);
      const route = { kind: 'route', batchId: 'b1', recipe: 'nip', reason: 'label' } as const;
      intake.issue({ ...route, source: 'label' }, now);
    };
    const brewToGreen = async (merge: BaseMerge, more: Partial<DriverOptions> = {}) => {
      const hand = handRunner();
      const manager = fakeWorktrees();
      orderNip();
      const driver = await open({
        runner: hand.runner,
        worktrees: [{ repo: 'acme/app', base: 'origin/main', manager, merge }],
        ...more,
      });
      await driver.drive();
      assert.deepStrictEqual(hand.started, [implement]);
      hand.end(implement);
      await driver.drive();
      return { driver, hand, manager };
    };
    const greenPath = join('work', 'acme.app', 'attempts', 'b1', 'green', '1');
    const ledgerOf = (driver: Driver) =>
      driver.state().effects.get(effectKey.encode(baseMergeKey(green)));

    it('merges the base into the worktree of the last check before it runs, through the ledger', async () => {
      const { merge, calls } = fakeMerge();
      const { driver, hand } = await brewToGreen(merge);
      assert.deepStrictEqual(hand.started, [implement, green]);
      assert.deepStrictEqual(calls, [
        'abort',
        'fetch main',
        `merge ${BASE} into ${greenPath}: Merge main before green`,
      ]);
      assert.deepStrictEqual(ledgerOf(driver), { base: BASE, merged: MERGED });
      // A step that does not merge the base never fetched it.
      assert.equal(calls.filter((call) => call === 'fetch main').length, 1);
    });

    it('merges nothing when the base holds nothing new, and runs the check', async () => {
      const { merge, calls } = fakeMerge();
      merge.push.isAncestor = async () => true;
      const { driver, hand } = await brewToGreen(merge);
      assert.deepStrictEqual(hand.started, [implement, green]);
      assert.deepStrictEqual(calls, ['abort', 'fetch main']);
      assert.deepStrictEqual(ledgerOf(driver), { base: BASE });
    });

    it('leaves the batch Stuck on a divergence, naming the files, when the merge conflicts', async () => {
      const { merge } = fakeMerge(() => ({ kind: 'conflicts', files: ['a.ts', 'b.ts'] }));
      const { driver, hand } = await brewToGreen(merge);
      assert.deepStrictEqual(hand.started, [implement]);
      assert.deepStrictEqual(ledgerOf(driver), { base: BASE, conflicts: ['a.ts', 'b.ts'] });
      const lane = driver.state().batches.get('b1')?.lane;
      assert.ok(lane?.kind === 'stuck');
      assert.deepStrictEqual(lane.reason, {
        kind: 'blocked',
        stepId: 'green',
        blockerKind: 'divergence',
        summary: 'conflicts with main in a.ts, b.ts',
      });
      assert.deepStrictEqual(store.currentLeases(now), []);
    });

    it('fails the attempt retryably, recording nothing, when the base cannot be fetched', async () => {
      const { merge, failFetch } = fakeMerge();
      failFetch('git fetch failed: no route');
      const { driver, hand } = await brewToGreen(merge);
      assert.deepStrictEqual(hand.started, [implement]);
      assert.equal(ledgerOf(driver), undefined);
      const attempt = driver.state().batches.get('b1')?.steps.get('green')?.attempts.get(1);
      assert.deepStrictEqual(attempt?.phase === 'finished' && attempt.outcome, {
        kind: 'failed',
        retryable: true,
        reason: 'the base could not be merged: git fetch failed: no route',
      });
      assert.deepStrictEqual(store.currentLeases(now), []);
    });

    it('finds a merge a killed run made, and merges no second time', async () => {
      const { merge, calls } = fakeMerge();
      merge.worktree.head = async () => MERGED;
      const { driver, hand } = await brewToGreen(merge);
      assert.deepStrictEqual(hand.started, [implement, green]);
      assert.deepStrictEqual(calls, []);
      assert.deepStrictEqual(ledgerOf(driver), { base: BASE, merged: MERGED });
    });

    /** How green#1 ended. */
    const greenOutcome = (driver: Driver) => {
      const attempt = driver.state().batches.get('b1')?.steps.get('green')?.attempts.get(1);
      return attempt?.phase === 'finished' ? attempt.outcome : undefined;
    };

    for (const [moved, parents] of [
      ['a commit of its own', [FAKE_COMMIT]],
      ['a merge of another commit', ['d'.repeat(40), BASE]],
      ['a merge of three commits', [FAKE_COMMIT, BASE, 'd'.repeat(40)]],
    ] as const) {
      it(`fails the attempt retryably, recording nothing, when its HEAD moved to ${moved}`, async () => {
        const { merge, calls } = fakeMerge();
        const moved = 'e'.repeat(40);
        merge.worktree.head = async () => moved;
        merge.worktree.parents = async () => [...parents];
        const { driver, hand } = await brewToGreen(merge);
        assert.deepStrictEqual(hand.started, [implement]);
        assert.deepStrictEqual(calls, []);
        assert.equal(ledgerOf(driver), undefined);
        assert.deepStrictEqual(greenOutcome(driver), {
          kind: 'failed',
          retryable: true,
          reason: `the base could not be merged: The worktree ${greenPath} moved from ${FAKE_COMMIT} to ${moved}, which is no merge of it`,
        });
      });
    }

    it('fails the attempt for good, running no check, when the ledger holds a merge the engine does not record', async () => {
      const { merge, calls } = fakeMerge();
      const key = effectKey.encode(baseMergeKey(green));
      // Both a merge commit and conflicts: no merge the engine records.
      const result = { base: BASE, merged: MERGED, conflicts: ['a.ts'] };
      const planted: EventStore = {
        ...store,
        findEffect: (found) =>
          effectKey.encode(found) === key ? { result } : store.findEffect(found),
      };
      const { driver, hand } = await brewToGreen(merge, { store: planted });
      assert.deepStrictEqual(hand.started, [implement]);
      assert.deepStrictEqual(calls, []);
      assert.deepStrictEqual(greenOutcome(driver), {
        kind: 'failed',
        retryable: false,
        reason: 'the ledger holds a merge of the base that is not one the engine records',
      });
    });

    it('renews its leases before the merge, as before every effect (review of #438)', async () => {
      const { merge } = fakeMerge();
      const other = attemptKey.encode(plan('b2'));
      // When the merge starts: when the lease of b2's running plan expires.
      let expires: Date | undefined;
      merge.push.baseTip = async () => {
        expires = store.currentLeases(now).find((lease) => lease.attemptKey === other)?.expiresAt;
        return BASE;
      };
      const hand = handRunner();
      orderNip();
      order('b2');
      const driver = await open({
        runner: hand.runner,
        worktrees: [{ repo: 'acme/app', base: 'origin/main', manager: fakeWorktrees(), merge }],
      });
      await driver.drive();
      assert.deepStrictEqual(hand.started, [implement, plan('b2')]);
      now = at(4);
      hand.end(implement);
      await driver.drive();
      assert.deepStrictEqual(hand.started, [implement, plan('b2'), green]);
      assert.deepStrictEqual(expires, at(9));
    });

    it('names at most 50 of the files a merge conflicts in', async () => {
      const files = Array.from({ length: 51 }, (_, n) => `f${n}.ts`);
      const { merge } = fakeMerge(() => ({ kind: 'conflicts', files }));
      const { driver } = await brewToGreen(merge);
      const named = files.slice(0, 50);
      assert.deepStrictEqual(ledgerOf(driver), { base: BASE, conflicts: named });
      const lane = driver.state().batches.get('b1')?.lane;
      assert.ok(lane?.kind === 'stuck');
      assert.deepStrictEqual(lane.reason, {
        kind: 'blocked',
        stepId: 'green',
        blockerKind: 'divergence',
        summary: `conflicts with main in ${named.join(', ')}`,
      });
    });

    it("gives the merge up at an effect's deadline, and fails the attempt retryably", async () => {
      const { merge } = fakeMerge();
      // A fetch that hangs until it is aborted.
      merge.push.baseTip = (_base, signal) =>
        new Promise((_, reject) => signal?.addEventListener('abort', () => reject(signal.reason)));
      const effects = { due: () => [], target: fakeHost().target, deadlineMs: 1 };
      const { driver, hand } = await brewToGreen(merge, { effects });
      assert.deepStrictEqual(hand.started, [implement]);
      assert.equal(ledgerOf(driver), undefined);
      assert.deepStrictEqual(greenOutcome(driver), {
        kind: 'failed',
        retryable: true,
        reason:
          'the base could not be merged: The effect ["b1","green",1,"merge_base"] took longer than its deadline of 1 ms',
      });
      assert.deepStrictEqual(store.currentLeases(now), []);
    });
  });

  describe('sessions (ADR 0116)', () => {
    const manager = () => ({
      worktrees: [{ repo: 'acme/app', base: 'origin/main', manager: fakeWorktrees() }],
    });
    const ids = () => {
      let next = 0;
      return () => `0f8fad5b-d9cb-469f-a165-70867728950${next++}`;
    };
    const recorded = <T extends 'step.started' | 'step.finished'>(type: T) =>
      store
        .eventsAfter(0)
        .flatMap(({ event }) =>
          event.type === type ? [event as Extract<Event, { type: T }>] : [],
        );
    const implement = { batchId: 'b1', stepId: 'implement', attempt: 1 };
    const claude = { version: '2.1.301', model: 'claude-sonnet-5-5' };

    it("records each brewer attempt's session in its step.started: a new id, in its worktree", async () => {
      const { runner, end } = handRunner();
      order('b1');
      const driver = await open({ runner, ...manager(), sessionId: ids() });
      await driver.drive();
      end(plan('b1'), { kind: 'failed', retryable: true, reason: 'flaky' });
      await driver.drive();
      end(plan('b1', 2));
      await driver.drive();
      assert.deepStrictEqual(
        recorded('step.started').map(({ stepId, attempt, session, worktree }) => ({
          step: `${stepId}#${attempt}`,
          session,
          path: worktree?.path,
        })),
        [
          ['plan#1', '0', join('b1', 'plan', '1')],
          ['plan#2', '1', join('b1', 'plan', '2')],
          ['implement#1', '2', join('b1', 'implement', '1')],
        ].map(([step, id, folder]) => {
          const path = join('work', 'acme.app', 'attempts', folder ?? '');
          return {
            step,
            session: { id: `0f8fad5b-d9cb-469f-a165-70867728950${id}`, worktree: path },
            path,
          };
        }),
      );
    });

    it('draws a new random session id for each attempt by default', async () => {
      const { runner, end } = handRunner();
      order('b1');
      const driver = await open({ runner, ...manager() });
      await driver.drive();
      end(plan('b1'), { kind: 'failed', retryable: true, reason: 'flaky' });
      await driver.drive();
      const ids = recorded('step.started').map(({ session }) => session?.id ?? '');
      assert.equal(ids.length, 2);
      assert.notEqual(ids[0], ids[1]);
      for (const id of ids) {
        assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      }
    });

    it('records no session for an attempt that runs no brewer, as a check step', async () => {
      const { runner, end } = handRunner();
      order('b1');
      const driver = await open({
        runner,
        ...manager(),
        sessionId: ids(),
        brews: ({ stepId }) => stepId !== 'implement',
      });
      await driver.drive();
      end(plan('b1'));
      await driver.drive();
      const [first, second] = recorded('step.started');
      assert.equal(first?.session?.id, '0f8fad5b-d9cb-469f-a165-708677289500');
      assert.equal(second?.stepId, 'implement');
      assert.equal(second?.session, undefined);
      assert.ok(second?.worktree, 'the check step still gets its worktree');
    });

    it("records the version and model claude reported on step.finished, and none when claude's init never came", async () => {
      const { runner, end } = handRunner();
      order('b1');
      const driver = await open({ runner, ...manager(), sessionId: ids() });
      await driver.drive();
      const sessionId = '0f8fad5b-d9cb-469f-a165-708677289500';
      end(plan('b1'), succeeded, {
        session: { sessionId, model: claude.model, claudeVersion: claude.version },
      });
      await driver.drive();
      end(implement, { kind: 'failed', retryable: false, reason: 'claude was not found on PATH' });
      await driver.drive();
      const [planned, implemented] = recorded('step.finished');
      assert.deepStrictEqual(planned?.claude, claude);
      assert.ok(!('session' in (planned ?? {})), 'the session id stays on step.started');
      assert.equal(implemented?.stepId, 'implement');
      assert.equal(implemented?.claude, undefined);
    });

    it('records the house-yeast rules an attempt ended with on its step.finished (ADR 0169)', async () => {
      const { runner, end } = handRunner();
      order('b1');
      const driver = await open({ runner, ...manager(), sessionId: ids() });
      await driver.drive();
      const houseYeast = { selected: ['waits'], cut: ['huge'], invalid: ['house-yeast/bad.md'] };
      end(plan('b1'), succeeded, { houseYeast });
      await driver.drive();
      const [planned] = recorded('step.finished');
      assert.deepStrictEqual(planned?.houseYeast, houseYeast);
    });

    it('records the receipt of an attempt on its step.finished (ADR 0172)', async () => {
      const { runner, end } = handRunner();
      order('b1');
      const driver = await open({ runner, ...manager(), sessionId: ids() });
      await driver.drive();
      const receipt = {
        complete: false,
        durationMs: 61_000,
        turns: 4,
        edits: 2,
        toolErrors: 1,
        denied: [{ tool: 'Bash', count: 2, refused: ['git push'] }],
      };
      end(plan('b1'), succeeded, { receipt });
      await driver.drive();
      const [planned] = recorded('step.finished');
      assert.deepStrictEqual(planned?.receipt, receipt);
    });

    it('records the ending without a receipt the event cannot hold (ADR 0172)', async () => {
      const { runner, end } = handRunner();
      order('b1');
      const driver = await open({ runner, ...manager(), sessionId: ids() });
      await driver.drive();
      const receipt = { complete: true, turns: -1, edits: 0, toolErrors: 0, denied: [] };
      end(plan('b1'), succeeded, { receipt });
      await driver.drive();
      const [planned] = recorded('step.finished');
      assert.equal(planned?.outcome.kind, 'succeeded');
      assert.equal(planned?.receipt, undefined);
    });

    it('records the ending without claude when its init reported a blank version or model', async () => {
      const { runner, end } = handRunner();
      order('b1');
      const driver = await open({ runner, ...manager(), sessionId: ids() });
      await driver.drive();
      const sessionId = '0f8fad5b-d9cb-469f-a165-708677289500';
      end(plan('b1'), succeeded, { session: { sessionId, model: ' ', claudeVersion: '' } });
      await driver.drive();
      const [planned] = recorded('step.finished');
      assert.equal(planned?.outcome.kind, 'succeeded');
      assert.equal(planned?.claude, undefined);
    });
  });

  describe('resumed attempts (ADR 0117)', () => {
    const ids = () => {
      let next = 0;
      return () => `0f8fad5b-d9cb-469f-a165-70867728950${next++}`;
    };
    const first = '0f8fad5b-d9cb-469f-a165-708677289500';
    const started = () =>
      store.eventsAfter(0).flatMap(({ event }) => (event.type === 'step.started' ? [event] : []));
    const folder = (step: string, attempt: number) =>
      join('work', 'acme.app', 'attempts', 'b1', step, String(attempt));
    /** What claude reported in its init: the session it set up. */
    const inSession = (sessionId: string) => ({
      session: { sessionId, model: 'claude-sonnet-5-5', claudeVersion: '2.1.301' },
    });
    const flaky: Ending = { kind: 'failed', retryable: true, reason: 'claude crashed' };
    // The pint recipe with a third attempt of each step, so a resumed attempt can fail too.
    const thrice = fakeRecipes({
      pint: fakeRecipe({ steps: ['plan', 'implement'], maxAttempts: 3 }),
    });
    const openResuming = async (manager: FakeWorktrees, runner: BrewerRunner) =>
      open({
        runner,
        recipes: thrice,
        worktrees: [{ repo: 'acme/app', base: 'origin/main', manager }],
        sessionId: ids(),
        resumes: () => true,
      });

    it('resumes the session of a retried attempt in the worktree it made, with no worktree of its own', async () => {
      const { runner, end, started: ran } = handRunner();
      const manager = fakeWorktrees();
      order('b1');
      const driver = await openResuming(manager, runner);
      await driver.drive();
      end(plan('b1'), flaky, inSession(first));
      await driver.drive();
      const resumed = started().at(-1);
      assert.equal(resumed?.attempt, 2);
      assert.deepStrictEqual(resumed.session, {
        id: first,
        resumes: first,
        worktree: folder('plan', 1),
      });
      assert.equal(resumed.worktree, undefined);
      assert.deepStrictEqual(
        manager.calls.flatMap((call) => (call.kind === 'clean' ? [] : [[call.kind, call.ref]])),
        [
          ['create', plan('b1')],
          ['recreate', plan('b1')],
        ],
      );
      assert.deepStrictEqual(ran, [plan('b1'), plan('b1', 2)]);
    });

    it('resumes the session whose questions a human answered, in the worktree it made (#327, ADR 0118)', async () => {
      const { runner, end, started: ran } = handRunner();
      const manager = fakeWorktrees();
      order('b1');
      const driver = await openResuming(manager, runner);
      await driver.drive();
      const question = {
        q: 'Which cache?',
        options: ['sqlite', 'redis'],
        recommended: 'sqlite',
        whyBlocking: 'It sets the schema',
      };
      end(plan('b1'), { kind: 'needs_input', questions: [question] }, inSession(first));
      await driver.drive();
      const answers = [{ q: 'Which cache?', answer: 'redis' }];
      const answer = {
        kind: 'answer',
        batchId: 'b1',
        by: 'ada',
        via: 'terminal',
        answers,
      } as const;
      assert.equal(intake.issue(answer, now).kind, 'accepted');
      await driver.drive();
      const resumed = started().at(-1);
      assert.equal(resumed?.attempt, 2);
      assert.deepStrictEqual(resumed.session, {
        id: first,
        resumes: first,
        worktree: folder('plan', 1),
      });
      assert.equal(resumed.worktree, undefined);
      assert.deepStrictEqual(ran, [plan('b1'), plan('b1', 2)]);
    });

    it('recreates the worktree at the commit its maker recorded, and records the path it gave back', async () => {
      const { runner, end } = handRunner();
      const made = 'd'.repeat(40);
      const elsewhere = join('work', 'moved');
      const manager = fakeWorktrees({ commit: made, recreateRoot: elsewhere });
      order('b1');
      const driver = await openResuming(manager, runner);
      await driver.drive();
      end(plan('b1'), flaky, inSession(first));
      await driver.drive();
      assert.deepStrictEqual(
        manager.calls.filter((call) => call.kind === 'recreate'),
        [{ kind: 'recreate', ref: plan('b1'), commit: made }],
      );
      assert.equal(started().at(-1)?.session?.worktree, join(elsewhere, 'b1', 'plan', '1'));
    });

    it('resumes the same session again, in the worktree of the attempt that made it', async () => {
      const { runner, end } = handRunner();
      const manager = fakeWorktrees();
      order('b1');
      const driver = await openResuming(manager, runner);
      await driver.drive();
      end(plan('b1'), flaky, inSession(first));
      await driver.drive();
      end(plan('b1', 2), flaky, inSession(first));
      await driver.drive();
      const third = started().at(-1);
      assert.equal(third?.attempt, 3);
      assert.deepStrictEqual(third.session, {
        id: first,
        resumes: first,
        worktree: folder('plan', 1),
      });
      assert.deepStrictEqual(
        manager.calls.flatMap((call) => (call.kind === 'recreate' ? [call.ref] : [])),
        [plan('b1'), plan('b1')],
      );
    });

    it('starts the next step at the branch of the worktree a resumed attempt that succeeded ran in', async () => {
      const { runner, end } = handRunner();
      const manager = fakeWorktrees();
      order('b1');
      const driver = await openResuming(manager, runner);
      await driver.drive();
      end(plan('b1'), flaky, inSession(first));
      await driver.drive();
      end(plan('b1', 2), succeeded, inSession(first));
      await driver.drive();
      assert.deepStrictEqual(
        manager.calls.flatMap((call) =>
          call.kind === 'create' ? [[call.ref.stepId, call.base]] : [],
        ),
        [
          ['plan', 'origin/main'],
          ['implement', 'refs/heads/foedrum/b1/plan/1'],
        ],
      );
    });

    it('starts a resumed attempt only once the lease of the attempt before it is gone (ADR 0055)', async () => {
      const { runner, end, started: ran } = handRunner();
      const manager = fakeWorktrees();
      order('b1');
      const driver = await openResuming(manager, runner);
      await driver.drive();
      end(plan('b1'), { kind: 'failed', retryable: false, reason: 'no' }, inSession(first));
      await driver.drive();
      assert.equal(driver.state().batches.get('b1')?.lane.kind, 'stuck');
      // An engineer's `foedrum resume` holds plan#1's lease while its session runs (ADR 0126).
      const key = attemptKey.encode(plan('b1'));
      store.withTransaction((tx) =>
        tx.putLease({ attemptKey: key, owner: 'resume-4242', expiresAt: at(30) }),
      );
      const retry = { kind: 'retry', batchId: 'b1', by: 'octocat', via: 'terminal' } as const;
      assert.equal(intake.issue(retry, now).kind, 'accepted');
      await driver.drive();
      assert.deepStrictEqual(ran, [plan('b1')], 'plan#2 waits for the lease');
      assert.ok(!manager.calls.some((call) => call.kind === 'recreate'));
      store.withTransaction((tx) => tx.releaseLease(key));
      await driver.drive();
      assert.deepStrictEqual(ran, [plan('b1'), plan('b1', 2)]);
      assert.equal(started().at(-1)?.session?.resumes, first);
    });

    describe('a takeover that resumes a step (ADR 0127)', () => {
      /** plan#1 runs in the Cellar's session `first`, and `resume-1` takes the batch over. */
      const takenOver = async (resumes?: string) => {
        const cellar = handRunner(inSession(first));
        const manager = fakeWorktrees();
        order('b1');
        const driver = await openResuming(manager, cellar.runner);
        await driver.drive();
        const request = { batchId: 'b1', owner: 'resume-1', by: 'ann', via: 'terminal' } as const;
        const handover = { ...request, now, leaseMs: 5 * minute };
        const decision = takeOver(
          intake,
          resumes === undefined ? handover : { ...handover, resumes },
        );
        assert.equal(decision.kind, 'accepted');
        await driver.tick();
        return { cellar, manager, driver };
      };

      it('records the step it resumes on the handover', async () => {
        await takenOver('plan');
        const [handed] = store
          .eventsAfter(0)
          .flatMap(({ event }) => (event.type === 'batch.taken_over' ? [event] : []));
        assert.equal(handed?.resumes, 'plan');
        const state = fold(store.eventsAfter(0).map(({ event }) => event));
        assert.equal(state.batches.get('b1')?.takeover?.resumes, 'plan');
      });

      it('stops the run the driver that lost the batch has of that step, which records it cancelled and schedules a retry', async () => {
        const { cellar } = await takenOver('plan');
        assert.deepStrictEqual(cellar.stopped, [attemptKey.encode(plan('b1'))]);
        assert.deepStrictEqual(types(store, 'b1').slice(-3), [
          'batch.taken_over',
          'step.finished plan#1',
          'step.scheduled plan#2',
        ]);
        assert.deepStrictEqual(store.currentLeases(now), [], 'plan#1 let its lease go');
      });

      it('lets the new holder resume the session of the stopped run in the worktree it made', async () => {
        const { manager } = await takenOver('plan');
        const resumer = handRunner();
        await open({
          owner: 'resume-1',
          runner: resumer.runner,
          recipes: thrice,
          worktrees: [{ repo: 'acme/app', base: 'origin/main', manager }],
          sessionId: ids(),
          takes: (batchId) => batchId === 'b1',
          resumes: () => true,
        }).then((driver) => driver.drive());
        assert.deepStrictEqual(resumer.started, [plan('b1', 2)]);
        assert.deepStrictEqual(started().at(-1)?.session, {
          id: first,
          resumes: first,
          worktree: folder('plan', 1),
        });
      });

      for (const resumes of [undefined, 'implement']) {
        it(`stops nothing on a takeover that resumes ${resumes ?? 'no step'}`, async () => {
          const { cellar } = await takenOver(resumes);
          assert.deepStrictEqual(cellar.stopped, []);
        });
      }

      it('stops none of its own later runs of the step once it holds the batch again', async () => {
        const { cellar, driver } = await takenOver('plan');
        // resume let the batch go; the Cellar takes it at its next pass and starts plan#2.
        store.withTransaction((tx) => tx.releaseBatchLease('b1'));
        await driver.drive();
        assert.deepStrictEqual(cellar.started, [plan('b1'), plan('b1', 2)]);
        await driver.tick();
        assert.deepStrictEqual(cellar.stopped, [attemptKey.encode(plan('b1'))]);
      });

      it('stops nothing on a takeover from another owner', async () => {
        const cellar = handRunner(inSession(first));
        order('b1');
        const driver = await openResuming(fakeWorktrees(), cellar.runner);
        await driver.drive();
        const handover = {
          kind: 'take_over',
          batchId: 'b1',
          by: 'ann',
          via: 'terminal',
          from: 'session-7',
          to: 'resume-1',
          until: at(5).toISOString(),
          resumes: 'plan',
        } as const;
        assert.equal(intake.issue(handover, now).kind, 'accepted');
        holdFor('resume-1', 'b1');
        await driver.tick();
        assert.deepStrictEqual(cellar.stopped, []);
      });

      it('stops nothing once the owner the takeover gave the batch to no longer holds it', async () => {
        const cellar = handRunner(inSession(first));
        order('b1');
        const driver = await openResuming(fakeWorktrees(), cellar.runner);
        await driver.drive();
        const request = { batchId: 'b1', owner: 'resume-1', by: 'ann', via: 'terminal' } as const;
        const handover = { ...request, now, leaseMs: 5 * minute, resumes: 'plan' };
        assert.equal(takeOver(intake, handover).kind, 'accepted');
        // resume-1 let the batch go, and another driver holds it: nobody resumes plan now.
        holdFor('session-7', 'b1');
        await driver.tick();
        assert.deepStrictEqual(cellar.stopped, []);
      });
    });

    it('starts fresh, saying why, when the attempt before it has no session claude started', async () => {
      const { runner, end } = handRunner();
      const manager = fakeWorktrees();
      order('b1');
      const driver = await openResuming(manager, runner);
      await driver.drive();
      // claude's init never came: lost, or ended before it.
      end(plan('b1'), flaky);
      await driver.drive();
      const fresh = started().at(-1);
      assert.deepStrictEqual(fresh?.session, {
        id: '0f8fad5b-d9cb-469f-a165-708677289501',
        worktree: folder('plan', 2),
        fallback: 'plan#1 has no session claude started',
      });
      assert.equal(fresh.worktree?.path, folder('plan', 2));
      assert.ok(!manager.calls.some((call) => call.kind === 'recreate'));
    });

    it('starts fresh after a resumed attempt that found no session to resume', async () => {
      const { runner, end } = handRunner();
      const manager = fakeWorktrees();
      order('b1');
      const driver = await openResuming(manager, runner);
      await driver.drive();
      end(plan('b1'), flaky, inSession(first));
      await driver.drive();
      // The runner's ending when claude ends before its init while it resumes.
      const reason = 'claude could not resume the session: No conversation found';
      end(plan('b1', 2), { kind: 'failed', retryable: true, reason });
      await driver.drive();
      const fresh = started().at(-1);
      assert.equal(fresh?.attempt, 3);
      assert.deepStrictEqual(fresh.session, {
        id: '0f8fad5b-d9cb-469f-a165-708677289501',
        worktree: folder('plan', 3),
        fallback: 'plan#2 has no session claude started',
      });
    });

    it('starts the attempt a route schedules fresh: its step succeeded, and that branch holds the task tree', async () => {
      const { runner, end } = handRunner();
      const manager = fakeWorktrees();
      const routing = fakeRecipes({
        pint: fakeRecipe({
          steps: ['plan', 'implement'],
          routes: { implement: { failed: 'plan' } },
        }),
      });
      order('b1');
      const driver = await open({
        runner,
        recipes: routing,
        worktrees: [{ repo: 'acme/app', base: 'origin/main', manager }],
        sessionId: ids(),
        resumes: () => true,
      });
      await driver.drive();
      end(plan('b1'), succeeded, inSession(first));
      await driver.drive();
      const implement = { batchId: 'b1', stepId: 'implement', attempt: 1 };
      const final: Ending = { kind: 'failed', retryable: false, reason: 'tests fail' };
      end(implement, final, inSession('0f8fad5b-d9cb-469f-a165-708677289501'));
      await driver.drive();
      const routed = started().at(-1);
      assert.equal(routed?.stepId, 'plan');
      assert.equal(routed.attempt, 2);
      assert.deepStrictEqual(routed.session, {
        id: '0f8fad5b-d9cb-469f-a165-708677289502',
        worktree: folder('plan', 2),
      });
      assert.ok(!manager.calls.some((call) => call.kind === 'recreate'));
    });

    it('starts fresh, saying why, when its worktree manager cannot recreate worktrees', async () => {
      const { runner, end } = handRunner();
      const { recreate: _, ...manager } = fakeWorktrees();
      order('b1');
      const driver = await open({
        runner,
        recipes: thrice,
        worktrees: [{ repo: 'acme/app', base: 'origin/main', manager }],
        sessionId: ids(),
        resumes: () => true,
      });
      await driver.drive();
      end(plan('b1'), flaky, inSession(first));
      await driver.drive();
      const fresh = started().at(-1);
      assert.deepStrictEqual(fresh?.session, {
        id: '0f8fad5b-d9cb-469f-a165-708677289501',
        worktree: folder('plan', 2),
        fallback: 'the worktree of plan#1 cannot be recreated here',
      });
      assert.equal(fresh.worktree?.path, folder('plan', 2));
    });

    describe('after a turn overrun (ADR 0175)', () => {
      const overran: Ending = {
        kind: 'failed',
        retryable: true,
        reason: 'budget exceeded: 81 turns, maxTurns is 80',
        overran: 'turns',
      };
      /** The driver of a brewer that starts fresh, and the limits each attempt started with. */
      const openFresh = async (manager: Omit<FakeWorktrees, 'recreate'>, runner: BrewerRunner) => {
        const given: AttemptLimits[] = [];
        const driver = await open({
          runner: {
            ...runner,
            start: (attempt) => (given.push(attempt.limits), runner.start(attempt)),
          },
          recipes: thrice,
          worktrees: [{ repo: 'acme/app', base: 'origin/main', manager }],
          sessionId: ids(),
          resumes: () => false,
        });
        return { driver, given };
      };

      it('resumes the session whatever the brewer says, and tells the runner the session can be resumed', async () => {
        const { runner, end, started: ran } = handRunner();
        const manager = fakeWorktrees();
        order('b1');
        const { driver, given } = await openFresh(manager, runner);
        await driver.drive();
        end(plan('b1'), overran, inSession(first));
        await driver.drive();
        const resumed = started().at(-1);
        assert.equal(resumed?.attempt, 2);
        assert.deepStrictEqual(resumed.session, {
          id: first,
          resumes: first,
          worktree: folder('plan', 1),
        });
        assert.deepStrictEqual(ran, [plan('b1'), plan('b1', 2)]);
        assert.deepStrictEqual(
          given.map((limits) => limits.resumable),
          [true, true],
        );
      });

      it('does not tell the runner a session can be resumed when its worktree manager cannot recreate one', async () => {
        const { runner } = handRunner();
        const { recreate: _, ...manager } = fakeWorktrees();
        order('b1');
        const { driver, given } = await openFresh(manager, runner);
        await driver.drive();
        assert.deepStrictEqual(given, [defaultLimits]);
      });

      // Review of #496: resumeOf's why, when the attempt before finished with no init report.
      it("fails the retry with resumeOf's why when claude started no session to resume", async () => {
        const { runner, end, started: ran } = handRunner();
        order('b1');
        const { driver } = await openFresh(fakeWorktrees(), runner);
        await driver.drive();
        end(plan('b1'), overran);
        await driver.drive();
        assert.deepStrictEqual(ran, [plan('b1')], 'no run of the retry');
        const finished = store
          .eventsAfter(0)
          .flatMap(({ event }) => (event.type === 'step.finished' ? [event] : []));
        const last = finished.at(-1);
        assert.deepStrictEqual(last?.type === 'step.finished' && last.outcome, {
          kind: 'failed',
          retryable: false,
          reason:
            'the turn budget ran out, and its session cannot be resumed: plan#1 has no session claude started',
        });
      });

      // A fresh attempt would meet the same budget.
      it('fails the retry not retryably, with why, when the session cannot be resumed', async () => {
        const { runner, end, started: ran } = handRunner();
        const manager = fakeWorktrees({ refuseRecreate: () => 'The commit is no commit in clone' });
        order('b1');
        const { driver } = await openFresh(manager, runner);
        await driver.drive();
        end(plan('b1'), overran, inSession(first));
        await driver.drive();
        assert.deepStrictEqual(ran, [plan('b1')], 'no run of the retry');
        const finished = store
          .eventsAfter(0)
          .flatMap(({ event }) => (event.type === 'step.finished' ? [event] : []));
        assert.deepStrictEqual(finished.at(-1), {
          type: 'step.finished',
          ...plan('b1', 2),
          outcome: {
            kind: 'failed',
            retryable: false,
            reason:
              'the turn budget ran out, and its session cannot be resumed: the worktree of plan#1 could not be recreated: The commit is no commit in clone',
          },
        });
        const lane = fold(store.eventsAfter(0).map(({ event }) => event)).batches.get('b1')?.lane;
        assert.equal(lane?.kind, 'stuck');
      });
    });

    it('starts fresh, saying why, when the worktree of the session cannot be recreated', async () => {
      const { runner, end, started: ran } = handRunner();
      const manager = fakeWorktrees({ refuseRecreate: () => 'The commit is no commit in clone' });
      order('b1');
      const driver = await openResuming(manager, runner);
      await driver.drive();
      end(plan('b1'), flaky, inSession(first));
      await driver.drive();
      const fresh = started().at(-1);
      assert.deepStrictEqual(fresh?.session, {
        id: '0f8fad5b-d9cb-469f-a165-708677289501',
        worktree: folder('plan', 2),
        fallback: 'the worktree of plan#1 could not be recreated: The commit is no commit in clone',
      });
      assert.equal(fresh.worktree?.path, folder('plan', 2));
      assert.deepStrictEqual(ran, [plan('b1'), plan('b1', 2)]);
    });
  });

  describe('the repository a batch writes in (ADR 0063)', () => {
    const app = fakeWorktrees({ root: 'app-attempts' });
    const web = fakeWorktrees({ root: 'web-attempts' });
    const both = () => [
      { repo: 'acme/app', base: 'origin/main', manager: app },
      { repo: 'acme/web', base: 'origin/develop', manager: web },
    ];
    beforeEach(() => {
      app.calls.length = 0;
      web.calls.length = 0;
    });
    const route = (batchId: string) =>
      intake.issue(
        { kind: 'route', batchId, recipe: 'half', reason: 'label', source: 'label' },
        now,
      );
    /** The repository and base the attempt plan#1 of `batchId` was given. */
    const given = (batchId: string) => {
      const event = store
        .eventsAfter(0)
        .map(({ event }) => event)
        .find((event) => event.type === 'step.started' && event.batchId === batchId);
      return event?.type === 'step.started' ? event.worktree?.repo : undefined;
    };
    const creates = (manager: FakeWorktrees) =>
      manager.calls.flatMap((call) => (call.kind === 'create' ? [call.base] : []));

    it("gives a claimed issue's attempt a worktree of its own repository, from its base", async () => {
      intake.issue({ kind: 'order', batchId: 'web-7', order: { issue: 7, repo: 'acme/web' } }, now);
      route('web-7');
      const driver = await open({ worktrees: both() });
      await driver.drive();
      assert.equal(given('web-7'), 'acme/web');
      assert.deepStrictEqual([creates(app), creates(web)], [[], ['origin/develop']]);
    });

    it("gives a sub-order's attempt a worktree of the sub-order's repository", async () => {
      order('b1');
      const decomposed = {
        type: 'order.decomposed' as const,
        batchId: 'b1',
        subOrders: [{ issue: 101, repo: 'acme/web' }],
        dependencies: [],
      };
      assert.equal(intake.issue({ kind: 'record', event: decomposed }, now).kind, 'accepted');
      const sub = {
        kind: 'order' as const,
        batchId: 'b101',
        order: { issue: 101 },
        parentBatchId: 'b1',
      };
      assert.equal(intake.issue(sub, now).kind, 'accepted');
      route('b101');
      const driver = await open({ takes: (batchId) => batchId === 'b101', worktrees: both() });
      await driver.drive();
      assert.equal(given('b101'), 'acme/web');
    });

    it('finds the repository of a claimed issue whatever case its name is in', async () => {
      const order = { issue: 7, repo: 'Acme/Web' };
      intake.issue({ kind: 'order', batchId: 'web-7', order }, now);
      route('web-7');
      const driver = await open({ worktrees: both() });
      await driver.drive();
      assert.equal(given('web-7'), 'acme/web');
    });

    it("gives a sub-order's attempt its repository, also when its batch names no parent", async () => {
      order('b1');
      const decomposed = {
        type: 'order.decomposed' as const,
        batchId: 'b1',
        subOrders: [{ issue: 101, repo: 'acme/web' }],
        dependencies: [],
      };
      assert.equal(intake.issue({ kind: 'record', event: decomposed }, now).kind, 'accepted');
      const sub = { kind: 'order' as const, batchId: 'b101', order: { issue: 101 } };
      assert.equal(intake.issue(sub, now).kind, 'accepted');
      route('b101');
      const driver = await open({ takes: (batchId) => batchId === 'b101', worktrees: both() });
      await driver.drive();
      assert.equal(given('b101'), 'acme/web');
    });

    it("gives a Brewery order's attempt the Brewery's only repository", async () => {
      order('b1');
      const driver = await open({ worktrees: both().slice(1) });
      await driver.drive();
      assert.equal(given('b1'), 'acme/web');
    });

    it('fails the attempt of an order that names no repository among several, retryably', async () => {
      const { runner, started } = handRunner();
      order('b1');
      const driver = await open({ runner, worktrees: both() });
      await driver.drive();
      const finished = store
        .eventsAfter(0)
        .map(({ event }) => event)
        .find((event) => event.type === 'step.finished');
      assert.deepStrictEqual(finished?.type === 'step.finished' && finished.outcome, {
        kind: 'failed',
        retryable: true,
        reason:
          'the attempt could not get its worktree: batch b1 names no repository, and the Brewery has 2',
      });
      assert.deepStrictEqual([creates(app), creates(web), started], [[], [], []]);
    });

    it('fails the attempt of a claimed issue whose repository the Brewery does not list', async () => {
      intake.issue({ kind: 'order', batchId: 'api-3', order: { issue: 3, repo: 'acme/api' } }, now);
      route('api-3');
      const driver = await open({ worktrees: both() });
      await driver.drive();
      const reasons = store
        .eventsAfter(0)
        .flatMap(({ event }) =>
          event.type === 'step.finished' && event.outcome.kind === 'failed'
            ? [event.outcome.reason]
            : [],
        );
      assert.equal(
        reasons[0],
        'the attempt could not get its worktree: batch api-3 writes in acme/api, which the Brewery does not list',
      );
    });

    it('cleans what goes with the worktrees too, at its start and when a batch ended', async () => {
      const { runner, end } = handRunner();
      const settings = fakeWorktrees({ root: 'attempt-settings' });
      order('b1');
      const driver = await open({ runner, worktrees: both().slice(0, 1), alsoCleans: [settings] });
      await driver.drive();
      end(plan('b1'));
      await driver.drive();
      end({ batchId: 'b1', stepId: 'implement', attempt: 1 });
      await driver.drive();
      assert.deepStrictEqual(
        settings.cleans().map(({ scope }) => scope),
        [{}, { batchId: 'b1' }],
      );
    });
  });

  describe('the supervisor', () => {
    it('acts on its own and on free batches, never on one another driver holds', async () => {
      order('b1');
      order('b2');
      order('b3');
      const driver = await open({ takes: (id) => id === 'b1' });
      await driver.drive();
      holdFor('session-7', 'b3', 120);
      now = at(61);
      await driver.tick();
      const lanes = ['b1', 'b2', 'b3'].map((id) => driver.state().batches.get(id)?.lane.kind);
      assert.deepStrictEqual(lanes, ['stuck', 'stuck', 'brewing']);
    });
  });

  describe('effects', () => {
    /** b1 with a succeeded plan#1, held by `owner` when given. */
    const succeededPlan = (owner?: string) => {
      order('b1');
      const started = { type: 'step.started', ...plan('b1') } as const;
      intake.issue({ kind: 'record', event: started }, now);
      intake.issue({ kind: 'finish', ...plan('b1'), ending: succeeded }, now);
      if (owner !== undefined) holdFor(owner, 'b1');
    };

    it('applies the effects of a batch it holds, once, and records them in the ledger', async () => {
      const host = fakeHost();
      succeededPlan('cellar');
      const driver = await open({ effects: { due: commentsDue, target: host.target } });
      await driver.applyEffects();
      await driver.applyEffects();
      const key = { ...plan('b1'), effect: 'comment' };
      assert.deepStrictEqual(host.applied, ['["b1","plan",1,"comment"]']);
      assert.deepStrictEqual(store.findEffect(key), {
        result: { key: '["b1","plan",1,"comment"]' },
      });
    });

    it('applies nothing of a batch another driver holds, until its lease expired', async () => {
      const host = fakeHost();
      succeededPlan('session-7');
      const driver = await open({ effects: { due: commentsDue, target: host.target } });
      await driver.applyEffects();
      assert.deepStrictEqual(host.applied, []);
      now = at(5);
      await driver.applyEffects();
      assert.deepStrictEqual(host.applied, ['["b1","plan",1,"comment"]']);
      assert.equal(batchLease('b1')?.owner, 'cellar');
    });

    it("applies nothing of a batch taken over to it before the old holder's lease ran out (ADR 0124)", async () => {
      const host = fakeHost();
      succeededPlan();
      const handover = { by: 'ada', via: 'terminal', from: 'session-7', to: 'cellar' } as const;
      const until = at(3).toISOString();
      intake.issue({ kind: 'take_over', batchId: 'b1', ...handover, until }, now);
      holdFor('cellar', 'b1');
      const driver = await open({ effects: { due: commentsDue, target: host.target } });
      now = at(2);
      await driver.applyEffects();
      assert.deepStrictEqual(host.applied, []);
      now = at(3);
      await driver.applyEffects();
      assert.deepStrictEqual(host.applied, ['["b1","plan",1,"comment"]']);
    });

    it('applies nothing of a free batch it does not take', async () => {
      const host = fakeHost();
      succeededPlan();
      const driver = await open({
        takes: () => false,
        effects: { due: commentsDue, target: host.target },
      });
      await driver.applyEffects();
      assert.deepStrictEqual(host.applied, []);
    });

    describe('deadline (#130)', () => {
      /**
       * A target whose `apply` answers only after 300 ms, long past the deadlines below, unless
       * its signal aborts first; and the signals it was handed.
       */
      const hanging = () => {
        const signals: (AbortSignal | undefined)[] = [];
        const target: EffectTarget = {
          find: async () => undefined,
          apply: (key, signal) => {
            signals.push(signal);
            return new Promise((resolve) => {
              const timer = setTimeout(() => resolve({ key }), 300);
              signal?.addEventListener('abort', () => clearTimeout(timer));
            });
          },
        };
        return { target, signals };
      };

      it('gives an effect up at its deadline, aborting it, records nothing and reports it', async () => {
        const { target, signals } = hanging();
        const notices: DriverNotice[] = [];
        succeededPlan('cellar');
        const driver = await open({
          effects: { due: commentsDue, target, deadlineMs: 20 },
          report: (notice) => notices.push(notice),
        });
        await driver.applyEffects();
        assert.equal(signals[0]?.aborted, true);
        assert.equal(store.findEffect({ ...plan('b1'), effect: 'comment' }), undefined);
        assert.deepStrictEqual(
          notices.map((notice) => notice.kind),
          ['effect_failed'],
        );
        const [failed] = notices;
        assert.match(
          failed?.kind === 'effect_failed' ? String(failed.error) : '',
          /\["b1","plan",1,"comment"\] took longer than its deadline of 20 ms/,
        );
      });

      it('gives an effect half the lease when it names no deadline', async () => {
        const { target, signals } = hanging();
        const notices: DriverNotice[] = [];
        succeededPlan('cellar');
        const driver = await open({
          leaseMs: 40,
          effects: { due: commentsDue, target },
          report: (notice) => notices.push(notice),
        });
        await driver.applyEffects();
        assert.equal(signals[0]?.aborted, true);
        assert.match(
          notices[0]?.kind === 'effect_failed' ? String(notices[0].error) : '',
          /deadline of 20 ms/,
        );
      });

      for (const deadlineMs of [minute, 2 * minute, 0, -1, 1.5]) {
        it(`refuses a deadline of ${deadlineMs} ms with a lease of 1 minute, letting its lock go`, async () => {
          const lock = fakeLock('cellar');
          await assert.rejects(
            open({
              lock: () => lock,
              leaseMs: minute,
              effects: { due: commentsDue, target: fakeHost().target, deadlineMs },
            }),
            /deadline of an effect must be a whole number of milliseconds below the lease of 60000 ms/,
          );
          assert.equal(lock.held, false);
        });
      }
    });

    it('runs one pass at a time, so no two calls apply one effect at once', async () => {
      let open_ = (): void => {};
      const gate = new Promise<void>((resolve) => {
        open_ = resolve;
      });
      const host = fakeHost();
      const slow: EffectTarget = {
        find: host.target.find,
        apply: async (key) => {
          await gate;
          return host.target.apply(key);
        },
      };
      succeededPlan('cellar');
      const driver = await open({ effects: { due: commentsDue, target: slow } });
      const both = Promise.all([driver.applyEffects(), driver.applyEffects()]);
      open_();
      await both;
      assert.deepStrictEqual(host.applied, ['["b1","plan",1,"comment"]']);
    });

    it('keeps an ended batch while an effect of it is due, and lets it go once it is applied', async () => {
      const { runner, end } = handRunner();
      const host = fakeHost();
      let down = true;
      const flaky: EffectTarget = {
        find: host.target.find,
        apply: async (key) => {
          if (down) throw new Error('the code host is down');
          return host.target.apply(key);
        },
      };
      order('b1');
      const driver = await open({ runner, effects: { due: commentsDue, target: flaky } });
      await driver.drive();
      end(plan('b1'));
      await driver.drive();
      end({ batchId: 'b1', stepId: 'implement', attempt: 1 });
      await driver.tick();
      assert.equal(driver.state().batches.get('b1')?.lane.kind, 'on_tap');
      assert.deepStrictEqual(driver.held(), ['b1']);
      assert.equal(batchLease('b1')?.owner, 'cellar');
      down = false;
      await driver.tick();
      assert.equal(host.applied.length, 2);
      assert.deepStrictEqual(driver.held(), []);
      assert.equal(batchLease('b1'), undefined);
    });

    it("leaves a batch's other effects for the next pass after one fails, and applies other batches'", async () => {
      const host = fakeHost();
      let down = true;
      const tried: string[] = [];
      const flaky: EffectTarget = {
        find: host.target.find,
        apply: async (key) => {
          tried.push(key);
          if (down && key.startsWith('["b1"')) throw new Error('the code host is down');
          return host.target.apply(key);
        },
      };
      // b1 has two succeeded steps, so two comments; b2 has one.
      for (const [batchId, issue] of [
        ['b1', 1],
        ['b2', 2],
      ] as const) {
        intake.issue({ kind: 'order', batchId, order: { issue } }, now);
        const route = {
          kind: 'route',
          batchId,
          recipe: 'pint',
          reason: 'label',
          source: 'label',
        } as const;
        intake.issue(route, now);
      }
      for (const stepId of ['plan', 'implement']) {
        const ref = { batchId: 'b1', stepId, attempt: 1 };
        intake.issue({ kind: 'record', event: { type: 'step.started', ...ref } }, now);
        intake.issue({ kind: 'finish', ...ref, ending: succeeded }, now);
      }
      intake.issue({ kind: 'record', event: { type: 'step.started', ...plan('b2') } }, now);
      intake.issue({ kind: 'finish', ...plan('b2'), ending: succeeded }, now);
      const driver = await open({ effects: { due: commentsDue, target: flaky } });
      await driver.applyEffects();
      assert.deepStrictEqual(tried, ['["b1","plan",1,"comment"]', '["b2","plan",1,"comment"]']);
      assert.deepStrictEqual(host.applied, ['["b2","plan",1,"comment"]']);
      down = false;
      await driver.applyEffects();
      assert.deepStrictEqual(host.applied.slice(1).sort(), [
        '["b1","implement",1,"comment"]',
        '["b1","plan",1,"comment"]',
      ]);
    });

    it('reports an effect that failed, and keeps its batch held for the next pass', async () => {
      succeededPlan('cellar');
      const notices: unknown[] = [];
      const failing: EffectTarget = {
        find: async () => undefined,
        apply: async () => {
          throw new Error('the code host is down');
        },
      };
      const driver = await open({
        effects: { due: commentsDue, target: failing },
        report: (notice) => notices.push(notice),
      });
      await driver.applyEffects();
      assert.equal(notices.length, 1);
      assert.deepStrictEqual((notices[0] as { kind: string; key: EffectKey }).key, {
        ...plan('b1'),
        effect: 'comment',
      });
      assert.equal(store.findEffect({ ...plan('b1'), effect: 'comment' }), undefined);
      assert.deepStrictEqual(driver.held(), ['b1']);
    });
  });

  describe('a tick that takes long', () => {
    it('keeps every lease it holds alive while it applies effects for longer than a lease', async () => {
      const { runner } = handRunner();
      order('b1');
      // b2 and b3 are on tap after a succeeded plan, so a comment each is due.
      for (const [batchId, issue] of [
        ['b2', 2],
        ['b3', 3],
      ] as const) {
        intake.issue({ kind: 'order', batchId, order: { issue } }, now);
        const route = {
          kind: 'route',
          batchId,
          recipe: 'half',
          reason: 'label',
          source: 'label',
        } as const;
        intake.issue(route, now);
        intake.issue({ kind: 'record', event: { type: 'step.started', ...plan(batchId) } }, now);
        intake.issue({ kind: 'finish', ...plan(batchId), ending: succeeded }, now);
      }
      const host = fakeHost();
      // Each comment takes 4 minutes: two of them outlast a 5-minute lease.
      const slow: EffectTarget = {
        find: host.target.find,
        apply: async (key) => {
          now = new Date(now.getTime() + 4 * minute);
          return host.target.apply(key);
        },
      };
      // An earlier run of this driver took b2 and b3; it drives on with them.
      store.withTransaction((tx) => {
        tx.putBatchLease({ batchId: 'b2', owner: 'cellar', expiresAt: at(5) });
        tx.putBatchLease({ batchId: 'b3', owner: 'cellar', expiresAt: at(5) });
      });
      const driver = await open({
        runner,
        takes: (id) => id === 'b1',
        effects: { due: commentsDue, target: slow },
      });
      await driver.drive();
      await driver.applyEffects();
      assert.equal(host.applied.length, 2);
      assert.deepStrictEqual(now, at(8));
      assert.equal(batchLease('b1')?.owner, 'cellar', 'its batch lease is alive');
      assert.deepStrictEqual(
        store.currentLeases(now).map((lease) => lease.attemptKey),
        [attemptKey.encode(plan('b1'))],
        'the attempt lease of the attempt it runs is alive',
      );
    });

    it('stops a run whose attempt was lost while it ran', async () => {
      const { runner, started, stopped } = handRunner();
      order('b1');
      const driver = await open({ runner });
      await driver.drive();
      // Another driver's supervisor found plan#1's lease expired and lost it.
      intake.issue({ kind: 'lose', ...plan('b1'), reason: 'the lease of cellar expired' }, now);
      await driver.tick();
      assert.deepStrictEqual(stopped, [attemptKey.encode(plan('b1'))]);
      assert.deepStrictEqual(started, [plan('b1'), plan('b1', 2)]);
    });
  });

  describe('worktrees of a batch another writer ended', () => {
    it('cleans them once a terminal command cancelled the batch', async () => {
      const { runner, end } = handRunner();
      const manager = fakeWorktrees();
      order('b1');
      const driver = await open({
        runner,
        worktrees: [{ repo: 'acme/app', base: 'origin/main', manager }],
      });
      await driver.drive();
      const question = {
        q: 'Which cache?',
        options: ['sqlite', 'redis'],
        recommended: 'sqlite',
        whyBlocking: 'It sets the schema',
      };
      end(plan('b1'), { kind: 'needs_input', questions: [question] });
      await driver.drive();
      assert.equal(driver.state().batches.get('b1')?.lane.kind, 'stuck');
      intake.issue({ kind: 'cancel', batchId: 'b1', by: 'ada', via: 'terminal' }, now);
      await driver.tick();
      assert.deepStrictEqual(
        manager.cleans().map(({ scope }) => scope),
        [{}, { batchId: 'b1' }],
      );
    });
  });

  describe('drives that overlap', () => {
    it('runs one drive at a time, so two calls start an attempt once', async () => {
      const { runner, started } = handRunner();
      order('b1');
      let open_ = (): void => {};
      const gate = new Promise<void>((resolve) => {
        open_ = resolve;
      });
      const manager = fakeWorktrees();
      const create = manager.create.bind(manager);
      manager.create = async (ref, base) => {
        await gate;
        return create(ref, base);
      };
      const driver = await open({
        runner,
        worktrees: [{ repo: 'acme/app', base: 'origin/main', manager }],
      });
      // A tick's drive and a direct one, both while plan#1's worktree is being made.
      const both = Promise.all([driver.drive(), driver.drive()]);
      open_();
      await both;
      assert.equal(manager.calls.filter((call) => call.kind === 'create').length, 1);
      assert.deepStrictEqual(started, [plan('b1')]);
      assert.deepStrictEqual(
        types(store, 'b1').filter((type) => type.startsWith('step.')),
        ['step.scheduled plan#1', 'step.started plan#1'],
      );
    });
  });

  describe('a run whose end rejects (#130)', () => {
    const outcomeOf = (driver: Driver, ref: AttemptRef) => {
      const attempt = driver.state().batches.get(ref.batchId)?.steps.get(ref.stepId);
      const found = attempt?.attempts.get(ref.attempt);
      return found?.phase === 'finished' ? found.outcome : undefined;
    };

    it('blocks the attempt on its environment, lets its lease go and reports it, while the other runs end', async () => {
      const { runner, started, reject, end } = handRunner();
      const notices: DriverNotice[] = [];
      order('b1');
      order('b2');
      const driver = await open({ runner, report: (notice) => notices.push(notice) });
      await driver.drive();
      const broken = new Error('the stream reader broke');
      reject(plan('b1'), broken);
      end(plan('b2'));
      await assert.doesNotReject(driver.drive());
      assert.deepStrictEqual(outcomeOf(driver, plan('b1')), {
        kind: 'failed',
        retryable: false,
        reason: 'blocked (environment): the stream reader broke',
      });
      assert.equal(driver.state().batches.get('b1')?.lane.kind, 'stuck');
      assert.deepStrictEqual(
        notices.filter((notice) => notice.kind === 'run_failed'),
        [{ kind: 'run_failed', ref: plan('b1'), error: broken }],
      );
      // b2 went on: its plan#1 is recorded, and its implement#1 started.
      assert.equal(outcomeOf(driver, plan('b2'))?.kind, 'succeeded');
      assert.deepStrictEqual(started.at(-1), { batchId: 'b2', stepId: 'implement', attempt: 1 });
      // The runner still reports b1's plan#1 after its stop, but its lease went, and the tick
      // renews none of it.
      const b1 = attemptKey.encode(plan('b1'));
      assert.ok(!store.currentLeases(now).some((lease) => lease.attemptKey === b1));
      now = at(4);
      await driver.tick();
      assert.ok(!store.currentLeases(now).some((lease) => lease.attemptKey === b1));
    });

    it('lets its lease go when its finish is refused', async () => {
      const { runner, reject } = handRunner();
      const notices: DriverNotice[] = [];
      order('b1');
      const driver = await open({ runner, report: (notice) => notices.push(notice) });
      await driver.drive();
      intake.issue({ kind: 'cancel', batchId: 'b1', by: 'ada', via: 'terminal' }, now);
      reject(plan('b1'), new Error('gone'));
      await assert.doesNotReject(driver.drive());
      assert.deepStrictEqual(store.currentLeases(now), []);
      assert.deepStrictEqual(
        notices.map((notice) => notice.kind),
        ['refused', 'run_failed'],
      );
    });

    it('names something that is no Error by its text', async () => {
      const { runner } = handRunner();
      let fail: (reason: unknown) => void = () => {};
      order('b1');
      const driver = await open({
        runner: {
          ...runner,
          start: () => ({
            ended: new Promise<AttemptEnd>((_, rejectWith) => {
              fail = rejectWith;
            }),
            stop: () => {},
          }),
        },
      });
      await driver.drive();
      fail('a string');
      await assert.doesNotReject(driver.drive());
      assert.deepStrictEqual(outcomeOf(driver, plan('b1')), {
        kind: 'failed',
        retryable: false,
        reason: 'blocked (environment): a string',
      });
    });

    /** Orders b1, starts it, rejects its end with `error`, and drives on. */
    const rejectWith = async (error: Error) => {
      const hand = handRunner();
      order('b1');
      const driver = await open({ runner: hand.runner });
      await driver.drive();
      hand.reject(plan('b1'), error);
      await assert.doesNotReject(driver.drive());
      return { driver, stopped: hand.stopped };
    };

    it('keeps the first line of the message, at most 120 characters, since the runner may quote what it read', async () => {
      const { driver } = await rejectWith(
        new Error(`${'x'.repeat(300)}\nthe rest of a stderr tail`),
      );
      assert.deepStrictEqual(outcomeOf(driver, plan('b1')), {
        kind: 'failed',
        retryable: false,
        reason: `blocked (environment): ${'x'.repeat(120)}`,
      });
    });

    it('names a rejection with no message by a fixed text, so its finish is recorded', async () => {
      const { driver } = await rejectWith(new Error(' '));
      assert.deepStrictEqual(outcomeOf(driver, plan('b1')), {
        kind: 'failed',
        retryable: false,
        reason: 'blocked (environment): the brewer runner failed without a message',
      });
    });

    /** Opens a driver on a run that rejects with `error` and whose `stop` is `stop`, and drives on. */
    const brokenRun = async (error: unknown, stop: () => void) => {
      const notices: DriverNotice[] = [];
      let fail: (reason: unknown) => void = () => {};
      order('b1');
      const driver = await open({
        report: (notice) => notices.push(notice),
        runner: {
          ...handRunner().runner,
          start: () => ({
            ended: new Promise<AttemptEnd>((_, rejectWith) => {
              fail = rejectWith;
            }),
            stop,
          }),
        },
      });
      await driver.drive();
      fail(error);
      await assert.doesNotReject(driver.drive());
      assert.deepStrictEqual(store.currentLeases(now), []);
      assert.deepStrictEqual(
        notices.filter((notice) => notice.kind === 'run_failed'),
        [{ kind: 'run_failed', ref: plan('b1'), error }],
      );
      return driver;
    };

    it('records the end when the error of the broken run cannot be read', async () => {
      const unreadable = Object.assign(new Error(), { message: 42 });
      const driver = await brokenRun(unreadable, () => {});
      assert.deepStrictEqual(outcomeOf(driver, plan('b1')), {
        kind: 'failed',
        retryable: false,
        reason: 'blocked (environment): the brewer runner failed without a message',
      });
    });

    it('records the end when the broken run cannot be stopped', async () => {
      // A stop that throws: the driver must keep it from the test and record the end anyway.
      const driver = await brokenRun(new Error('the stream reader broke'), () =>
        assert.fail('the process is gone'),
      );
      assert.equal(outcomeOf(driver, plan('b1'))?.kind, 'failed');
    });

    it('stops the run whose end rejected while it still holds its lease (I2)', async () => {
      const hand = handRunner();
      const key = attemptKey.encode(plan('b1'));
      const leasedAtStop: boolean[] = [];
      order('b1');
      const driver = await open({
        runner: {
          ...hand.runner,
          start: (attempt) => {
            const run = hand.runner.start(attempt);
            return {
              ended: run.ended,
              stop: () => {
                leasedAtStop.push(store.currentLeases(now).some((l) => l.attemptKey === key));
                run.stop();
              },
            };
          },
        },
      });
      await driver.drive();
      hand.reject(plan('b1'), new Error('the stream reader broke'));
      await driver.drive();
      assert.deepStrictEqual(leasedAtStop, [true]);
      assert.deepStrictEqual(store.currentLeases(now), []);
    });

    it('stops the run whose end rejected, since its process may still run', async () => {
      const { stopped } = await rejectWith(new Error('the stream reader broke'));
      assert.deepStrictEqual(stopped, [attemptKey.encode(plan('b1'))]);
    });
  });

  describe('an end whose record throws (#278)', () => {
    const bound = (target: object, name: string | symbol) => {
      const value = Reflect.get(target, name);
      return typeof value === 'function' ? value.bind(target) : value;
    };
    /** `store`, whose next append of `ref`'s finish throws `error` once. */
    const failingFinish = (ref: AttemptRef, error: Error): EventStore => {
      let armed = true;
      return new Proxy(store, {
        get: (target, name) =>
          name !== 'withTransaction'
            ? bound(target, name)
            : <T>(fn: (tx: EventStoreTransaction) => T): T =>
                target.withTransaction((tx) =>
                  fn(
                    new Proxy(tx, {
                      get: (inner, key) =>
                        key !== 'append'
                          ? bound(inner, key)
                          : (event: Event) => {
                              const finish =
                                event.type === 'step.finished' &&
                                attemptKey.encode(event) === attemptKey.encode(ref);
                              if (armed && finish) {
                                armed = false;
                                throw error;
                              }
                              return inner.append(event);
                            },
                    }),
                  ),
                ),
      });
    };
    const outcomeOf = (driver: Driver, ref: AttemptRef) => {
      const found = driver.state().batches.get(ref.batchId)?.steps.get(ref.stepId);
      const attempt = found?.attempts.get(ref.attempt);
      return attempt?.phase === 'finished' ? attempt.outcome : undefined;
    };
    const leased = (ref: AttemptRef): boolean =>
      store.currentLeases(now).some((lease) => lease.attemptKey === attemptKey.encode(ref));

    it('records the other ends of its pass, lets their leases go and reports it', async () => {
      const { runner, end } = handRunner();
      const notices: DriverNotice[] = [];
      order('b1');
      order('b2');
      const full = new Error('the disk is full');
      const driver = await open({
        store: failingFinish(plan('b1'), full),
        runner,
        report: (notice) => notices.push(notice),
      });
      await driver.drive();
      end(plan('b1'));
      end(plan('b2'));
      await assert.doesNotReject(driver.drive());
      assert.equal(outcomeOf(driver, plan('b2'))?.kind, 'succeeded');
      assert.ok(!leased(plan('b2')));
      assert.deepStrictEqual(
        notices.filter((notice) => notice.kind === 'command_failed'),
        [
          {
            kind: 'command_failed',
            command: { kind: 'finish', ...plan('b1'), ending: succeeded },
            error: full,
          },
        ],
      );
      // b1's end is not recorded: its lease stays until it expires, and the supervisor loses it.
      assert.equal(outcomeOf(driver, plan('b1')), undefined);
      assert.ok(leased(plan('b1')));
    });

    it('lets the lease of the end that threw expire, so the supervisor loses its attempt and retries it', async () => {
      const { runner, end, started } = handRunner();
      order('b1');
      const driver = await open({
        store: failingFinish(plan('b1'), new Error('the disk is full')),
        runner,
      });
      await driver.drive();
      end(plan('b1'));
      await driver.drive();
      // The heartbeat renews no lease of a run that ended.
      now = at(4);
      await driver.tick();
      now = at(6);
      await driver.tick();
      assert.ok(!leased(plan('b1')));
      const outcome = outcomeOf(driver, plan('b1'));
      assert.equal(outcome?.kind, 'failed');
      assert.deepStrictEqual(started.at(-1), plan('b1', 2));
    });

    it('still reports a rejected run whose blocked end threw, and records the other ends', async () => {
      const { runner, end, reject } = handRunner();
      const notices: DriverNotice[] = [];
      order('b1');
      order('b2');
      const full = new Error('the disk is full');
      const broken = new Error('the stream reader broke');
      const driver = await open({
        store: failingFinish(plan('b1'), full),
        runner,
        report: (notice) => notices.push(notice),
      });
      await driver.drive();
      reject(plan('b1'), broken);
      end(plan('b2'));
      await assert.doesNotReject(driver.drive());
      assert.deepStrictEqual(
        notices
          .filter((notice) => notice.kind === 'command_failed' || notice.kind === 'run_failed')
          .map((notice) => [notice.kind, 'error' in notice ? notice.error : undefined]),
        [
          ['command_failed', full],
          ['run_failed', broken],
        ],
      );
      assert.equal(outcomeOf(driver, plan('b2'))?.kind, 'succeeded');
      assert.ok(!leased(plan('b2')));
    });

    it('records the other ends of its pass when the read after an end throws (#289)', async () => {
      const { runner, end } = handRunner();
      const notices: DriverNotice[] = [];
      order('b1');
      order('b2');
      const broken = new Error('the store could not be read');
      // The first read of the store after b1's finish is committed throws: the batchIsOver check.
      let state: 'waiting' | 'armed' | 'thrown' = 'waiting';
      const failingRead = new Proxy(store, {
        get: (target, name) => {
          if (name === 'eventsAfter') {
            return (after: number) => {
              if (state === 'armed') {
                state = 'thrown';
                throw broken;
              }
              return target.eventsAfter(after);
            };
          }
          if (name !== 'withTransaction') return bound(target, name);
          return <T>(fn: (tx: EventStoreTransaction) => T): T => {
            let finished = false;
            const result = target.withTransaction((tx) =>
              fn(
                new Proxy(tx, {
                  get: (inner, key) =>
                    key !== 'append'
                      ? bound(inner, key)
                      : (event: Event) => {
                          finished ||=
                            event.type === 'step.finished' &&
                            attemptKey.encode(event) === attemptKey.encode(plan('b1'));
                          return inner.append(event);
                        },
                }),
              ),
            );
            if (finished && state === 'waiting') state = 'armed';
            return result;
          };
        },
      });
      const driver = await open({
        store: failingRead,
        runner,
        alsoCleans: [fakeWorktrees({ root: 'attempt-settings' })],
        report: (notice) => notices.push(notice),
      });
      await driver.drive();
      end(plan('b1'));
      end(plan('b2'));
      // Now or on the next drive: no end of the pass is left behind.
      await driver.drive().catch(() => {});
      await driver.drive().catch(() => {});
      assert.equal(state, 'thrown');
      assert.deepStrictEqual(
        notices.filter((notice) => notice.kind === 'command_failed'),
        [
          {
            kind: 'command_failed',
            command: { kind: 'finish', ...plan('b1'), ending: succeeded },
            error: broken,
          },
        ],
      );
      assert.equal(outcomeOf(driver, plan('b1'))?.kind, 'succeeded');
      assert.equal(outcomeOf(driver, plan('b2'))?.kind, 'succeeded');
      assert.ok(!leased(plan('b1')));
      assert.ok(!leased(plan('b2')));
    });
  });

  describe('a start that is refused', () => {
    it('tries it once per drive, so drive ends', async () => {
      const { runner } = handRunner();
      order('b1');
      // The worktree's commit is no sha, so the guard refuses the step.started that records it.
      let creates = 0;
      const manager = fakeWorktrees({ commit: 'not-a-sha' });
      const create = manager.create.bind(manager);
      manager.create = async (ref, base) => {
        // A bound on the old endless loop: the twentieth try fails, so its attempt fails.
        if (++creates >= 20) throw new Error('enough');
        return create(ref, base);
      };
      const driver = await open({
        runner,
        worktrees: [{ repo: 'acme/app', base: 'origin/main', manager }],
      });
      await driver.drive();
      assert.equal(creates, 1);
      assert.equal(driver.state().batches.get('b1')?.lane.kind, 'brewing');
    });
  });

  describe('an action step (ADR 0071)', () => {
    const url = 'https://github.com/acme/api/pull/12';
    /** Orders `batchId` and routes it to the ale recipe: plan, then the action. */
    const orderAle = (batchId: string): void => {
      const issue = Number(batchId.slice(1));
      assert.equal(
        intake.issue({ kind: 'order', batchId, order: { issue } }, now).kind,
        'accepted',
      );
      const route = {
        kind: 'route',
        batchId,
        recipe: 'ale',
        reason: 'label',
        source: 'label',
      } as const;
      assert.equal(intake.issue(route, now).kind, 'accepted');
    };

    /** Actions whose effects are a push and a pull request, applied on a host the test can fail. */
    const fakeActions = (failing: string[] = []) => {
      const applied: string[] = [];
      const asked: string[] = [];
      const actions: DriverActions = {
        due: (_state, ref) => {
          asked.push(attemptKey.encode(ref));
          return [
            { batchId: ref.batchId, effect: 'push' },
            { batchId: ref.batchId, effect: 'pull_request' },
          ];
        },
        target: {
          find: async () => undefined,
          apply: async (key) => {
            if (failing.includes(key)) {
              failing.splice(failing.indexOf(key), 1);
              throw new Error('the code host is down');
            }
            applied.push(key);
            return key.includes('pull_request') ? url : { commit: 'c'.repeat(40) };
          },
        },
        ending: () => ({ kind: 'succeeded', output: { pullRequest: url } }),
      };
      return { actions, applied, asked };
    };
    const push = JSON.stringify(['b1', 'push']);
    const pullRequest = JSON.stringify(['b1', 'pull_request']);

    it('starts the action itself, never on the runner, applies its effects and ends it', async () => {
      const brewer = handRunner();
      const { actions, applied } = fakeActions();
      orderAle('b1');
      const driver = await open({ runner: brewer.runner, actions });
      await driver.drive();
      brewer.end(plan('b1'));
      await driver.tick();
      assert.deepStrictEqual(brewer.started, [plan('b1')]);
      assert.deepStrictEqual(applied, [push, pullRequest]);
      assert.deepStrictEqual(types(store, 'b1').slice(-4), [
        'step.scheduled open#1',
        'step.started open#1',
        'step.finished open#1',
        'batch.on_tap',
      ]);
      const finished = driver.state().batches.get('b1')?.steps.get('open')?.attempts.get(1);
      assert.deepStrictEqual(finished?.phase === 'finished' && finished.outcome, {
        kind: 'succeeded',
        output: { pullRequest: url },
      });
      assert.deepStrictEqual(driver.state().batches.get('b1')?.lane, {
        kind: 'on_tap',
        pullRequests: [url],
      });
    });

    it('takes no lease for the action, so no supervisor loses it while its effects fail', async () => {
      const brewer = handRunner();
      const reported: DriverNotice[] = [];
      const { actions, applied } = fakeActions([push, push]);
      orderAle('b1');
      const driver = await open({
        runner: brewer.runner,
        actions,
        report: (n) => reported.push(n),
      });
      await driver.drive();
      brewer.end(plan('b1'));
      await driver.tick();
      assert.deepStrictEqual(store.currentLeases(now), []);
      now = at(30);
      await driver.tick();
      assert.deepStrictEqual(applied, []);
      assert.equal(reported.filter((notice) => notice.kind === 'effect_failed').length, 2);
      assert.equal(
        driver.state().batches.get('b1')?.steps.get('open')?.attempts.get(1)?.phase,
        'started',
      );
      await driver.tick();
      assert.deepStrictEqual(applied, [push, pullRequest]);
      assert.equal(driver.state().batches.get('b1')?.lane.kind, 'on_tap');
    });

    it('opens no pull request before the push is recorded: a failed push stops the pass', async () => {
      const brewer = handRunner();
      const { actions, applied } = fakeActions([push]);
      orderAle('b1');
      const driver = await open({ runner: brewer.runner, actions });
      await driver.drive();
      brewer.end(plan('b1'));
      await driver.tick();
      assert.deepStrictEqual(applied, []);
    });

    it('ends the attempt from the ledger when a driver before it applied both and died', async () => {
      const { actions, applied } = fakeActions();
      orderAle('b1');
      const brewer = handRunner();
      const first = await open({ runner: brewer.runner, actions: fakeActions().actions });
      await first.drive();
      brewer.end(plan('b1'));
      await first.drive();
      first.close();
      // The action's start and both effects were recorded; its end was not.
      for (const key of [push, pullRequest]) {
        const event = { type: 'effect.applied', key, result: key === push ? {} : url } as const;
        assert.equal(intake.issue({ kind: 'record', event }, now).kind, 'accepted');
      }
      const second = await open({ actions });
      await second.tick();
      assert.deepStrictEqual(applied, []);
      assert.equal(second.state().batches.get('b1')?.lane.kind, 'on_tap');
    });

    it('applies the actions of a batch another driver holds only once it has the batch', async () => {
      const brewer = handRunner();
      const { actions, applied } = fakeActions();
      orderAle('b1');
      const driver = await open({ runner: brewer.runner, actions });
      await driver.drive();
      brewer.end(plan('b1'));
      await driver.drive();
      holdFor('other', 'b1', 10);
      await driver.applyEffects();
      assert.deepStrictEqual(applied, []);
      assert.equal(driver.state().batches.get('b1')?.lane.kind, 'brewing');
    });

    it('continues a retry of the action where the first attempt stopped: no second push', async () => {
      const brewer = handRunner();
      const { actions, applied } = fakeActions([pullRequest]);
      orderAle('b1');
      const driver = await open({ runner: brewer.runner, actions });
      await driver.drive();
      brewer.end(plan('b1'));
      await driver.tick();
      assert.deepStrictEqual(applied, [push]);
      // Past the action's deadline, the batch is Stuck; a human retries it.
      now = at(61);
      await driver.tick();
      assert.equal(driver.state().batches.get('b1')?.lane.kind, 'stuck');
      const retry = { kind: 'retry', batchId: 'b1', by: 'octocat', via: 'terminal' } as const;
      assert.equal(intake.issue(retry, now).kind, 'accepted');
      await driver.tick();
      assert.deepStrictEqual(applied, [push, pullRequest]);
      const second = driver.state().batches.get('b1')?.steps.get('open')?.attempts.get(2);
      assert.equal(second?.phase, 'finished');
      assert.deepStrictEqual(driver.state().batches.get('b1')?.lane, {
        kind: 'on_tap',
        pullRequests: [url],
      });
    });

    it('ends the action only under the batch lease, once another driver lets it go', async () => {
      const brewer = handRunner();
      const { actions } = fakeActions();
      orderAle('b1');
      const driver = await open({ runner: brewer.runner, actions });
      await driver.drive();
      brewer.end(plan('b1'));
      await driver.drive();
      for (const key of [push, pullRequest]) {
        const event = { type: 'effect.applied', key, result: key === push ? {} : url } as const;
        assert.equal(intake.issue({ kind: 'record', event }, now).kind, 'accepted');
      }
      holdFor('other', 'b1', 10);
      await driver.applyEffects();
      assert.equal(
        driver.state().batches.get('b1')?.steps.get('open')?.attempts.get(1)?.phase,
        'started',
      );
      now = at(11);
      await driver.applyEffects();
      assert.equal(driver.state().batches.get('b1')?.lane.kind, 'on_tap');
    });

    it("applies the action's effects after the batch's other effects, and none after one fails", async () => {
      const brewer = handRunner();
      const { actions, applied } = fakeActions();
      const comment = JSON.stringify(['b1', 'comment']);
      let failing = 1;
      const effects = {
        due: (_state: State, batchId: string) =>
          batchId === 'b1' ? [{ batchId, effect: 'comment' }] : [],
        target: {
          find: async () => undefined,
          apply: async (key: string) => {
            if (failing-- > 0) throw new Error('the code host is down');
            applied.push(key);
            return null;
          },
        },
      };
      orderAle('b1');
      const driver = await open({ runner: brewer.runner, actions, effects });
      await driver.drive();
      brewer.end(plan('b1'));
      await driver.tick();
      assert.deepStrictEqual(applied, []);
      await driver.tick();
      assert.deepStrictEqual(applied, [comment, push, pullRequest]);
    });

    it('opens no pull request in the pass whose push found nothing to push', async () => {
      const brewer = handRunner();
      const applied: string[] = [];
      const emptied = (state: State): boolean =>
        (state.effects.get(push) as { empty?: boolean } | undefined)?.empty === true;
      const actions: DriverActions = {
        // As the pull request actions do: nothing more is due once the push recorded nothing.
        due: (state, ref) =>
          emptied(state)
            ? []
            : [
                { batchId: ref.batchId, effect: 'push' },
                { batchId: ref.batchId, effect: 'pull_request' },
              ],
        target: {
          find: async () => undefined,
          apply: async (key) => {
            applied.push(key);
            return key === push ? { empty: true } : url;
          },
        },
        ending: (state) =>
          emptied(state)
            ? { kind: 'failed', retryable: false, reason: 'nothing to push' }
            : { kind: 'succeeded', output: { pullRequest: url } },
      };
      orderAle('b1');
      const driver = await open({ runner: brewer.runner, actions });
      await driver.drive();
      brewer.end(plan('b1'));
      await driver.tick();
      assert.deepStrictEqual(applied, [push]);
      assert.equal(driver.state().batches.get('b1')?.lane.kind, 'stuck');
    });

    it('blocks the action on its environment when the driver has no actions to run it with', async () => {
      const brewer = handRunner();
      orderAle('b1');
      const driver = await open({ runner: brewer.runner });
      await driver.drive();
      brewer.end(plan('b1'));
      await driver.drive();
      assert.deepStrictEqual(brewer.started, [plan('b1')]);
      const attempt = driver.state().batches.get('b1')?.steps.get('open')?.attempts.get(1);
      assert.deepStrictEqual(attempt?.phase === 'finished' && attempt.outcome, {
        kind: 'failed',
        retryable: false,
        reason:
          'blocked (environment): the driver has no code host to run the openPullRequest action of step open on',
      });
      assert.deepStrictEqual(driver.state().batches.get('b1')?.lane.kind, 'stuck');
    });
  });

  describe('a pause (ADR 0202)', () => {
    const who = { by: 'ada', via: 'terminal' } as const;
    const pause = (issue?: number, stopAt?: number): void => {
      const decision = intake.issue(
        {
          kind: 'pause',
          ...(issue === undefined ? {} : { order: { issue } }),
          ...who,
          ...(stopAt === undefined ? {} : { stopAt: { at: at(stopAt), zone: 'UTC' } }),
        },
        now,
      );
      assert.equal(decision.kind, 'accepted', JSON.stringify(decision));
    };
    const resume = (issue?: number): void => {
      const order = issue === undefined ? {} : { order: { issue } };
      const decision = intake.issue({ kind: 'continue', ...order, ...who }, now);
      assert.equal(decision.kind, 'accepted', JSON.stringify(decision));
    };

    it('starts no attempt of a paused order, and starts it once the order continues', async () => {
      const { runner, started } = handRunner();
      order('b1');
      order('b2');
      pause(1);
      const driver = await open({ runner });
      await driver.tick();
      assert.deepStrictEqual(started, [plan('b2')]);
      resume(1);
      await driver.tick();
      assert.deepStrictEqual(started, [plan('b2'), plan('b1')]);
    });

    it('starts nothing at all under --all, a batch ordered after it neither', async () => {
      const { runner, started } = handRunner();
      order('b1');
      pause();
      // A person's own order is not held; what it schedules is.
      assert.equal(
        intake.issue({ kind: 'order_again', batchId: 'b2', order: { issue: 2 }, ...who }, now).kind,
        'accepted',
      );
      const driver = await open({ runner });
      await driver.tick();
      assert.deepStrictEqual(started, []);
    });

    it('lets a running attempt end at its own point, and starts nothing after it', async () => {
      const { runner, started, stopped, end } = handRunner();
      order('b1');
      const driver = await open({ runner });
      await driver.drive();
      pause(1, 30);
      now = at(10);
      await driver.tick();
      assert.deepStrictEqual(stopped, []);
      end(plan('b1'));
      await driver.tick();
      assert.deepStrictEqual(started, [plan('b1')]);
      const implement = driver.state().batches.get('b1')?.steps.get('implement');
      assert.equal(implement?.attempts.get(1)?.phase, 'scheduled');
      assert.deepStrictEqual(types(store, 'b1').slice(-2), [
        'step.finished plan#1',
        'step.scheduled implement#1',
      ]);
    });

    it('stops what still runs at the stopAt, as stopped by the pause, and runs it again on continue', async () => {
      const { runner, started, stopped } = handRunner();
      order('b1');
      const driver = await open({ runner });
      await driver.drive();
      pause(1, 30);
      now = at(29);
      await driver.tick();
      assert.deepStrictEqual(stopped, []);
      now = at(30);
      await driver.tick();
      await driver.tick();
      assert.deepStrictEqual(stopped, [attemptKey.encode(plan('b1'))]);
      const step = driver.state().batches.get('b1')?.steps.get('plan');
      const first = step?.attempts.get(1);
      assert.equal(first?.phase === 'finished' && first.paused, true);
      assert.equal(step?.attempts.get(2)?.phase, 'scheduled');
      assert.deepStrictEqual(started, [plan('b1')]);
      resume(1);
      await driver.tick();
      assert.deepStrictEqual(started, [plan('b1'), plan('b1', 2)]);
    });

    it('starts nothing paused after a restart, and goes on once continued', async () => {
      const first = handRunner();
      order('b1');
      pause(1);
      const driver = await open({ runner: first.runner });
      await driver.tick();
      driver.close();
      drivers.splice(drivers.indexOf(driver), 1);
      const second = handRunner();
      const again = await open({ runner: second.runner });
      await again.tick();
      assert.deepStrictEqual(second.started, []);
      resume(1);
      await again.tick();
      assert.deepStrictEqual(second.started, [plan('b1')]);
    });
  });
});
