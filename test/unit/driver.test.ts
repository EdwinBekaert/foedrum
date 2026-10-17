// The driver (ADR 0019, ADR 0033, ADR 0037): its lock and start come before any work, it holds the
// lease of every batch it drives and renews it, skips the batches another driver holds, stops at
// the next step boundary when it loses one, and applies a batch's effects only while it holds it.
// An in-memory store, a runner the test ends by hand, and a second command log for the intake and
// the other writers.

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { type AttemptRef, attemptKey } from '../../src/engine/attempt-key.ts';
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
  type DriverNotice,
  type DriverOptions,
  openDriver,
} from '../../src/engine/driver.ts';
import { DriverRunningError } from '../../src/engine/driver-lock.ts';
import type { EffectTarget } from '../../src/engine/effects.ts';
import type { EffectKey, EventStore } from '../../src/engine/event-store.ts';
import type { State } from '../../src/engine/fold.ts';
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
});
const succeeded: Ending = {
  kind: 'succeeded',
  output: { status: 'done', summary: 'Done', assumptions: [] },
};

/** A runner whose attempts run until the test ends them. */
const handRunner = () => {
  const running = new Map<string, (end: AttemptEnd) => void>();
  const started: AttemptRef[] = [];
  const stopped: string[] = [];
  const runner: BrewerRunner = {
    start: ({ ref }: AttemptStart) => {
      started.push(ref);
      const key = attemptKey.encode(ref);
      const ended = new Promise<AttemptEnd>((resolve) => running.set(key, resolve));
      return {
        ended,
        stop: () => {
          stopped.push(key);
          running.get(key)?.({ ending: { kind: 'cancelled' } });
          running.delete(key);
        },
      };
    },
    progress: (ref) =>
      running.has(attemptKey.encode(ref))
        ? { lastProgressAt: t0, turnsWithoutProgress: 0 }
        : undefined,
  };
  /** Ends the running attempt `ref` with `ending`. */
  const end = (ref: AttemptRef, ending: Ending = succeeded): void => {
    const key = attemptKey.encode(ref);
    const resolve = running.get(key);
    assert.ok(resolve, `${key} runs`);
    running.delete(key);
    resolve({ ending });
  };
  return { runner, started, stopped, end };
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
});
