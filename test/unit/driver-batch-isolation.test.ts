// One batch's error stops no other's work in the driver's tick (#870, ADR 0328): two batches on an
// in-memory store, a runner the test ends by hand, and a throw at one site of one batch.

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { type AttemptRef, attemptKey } from '../../src/engine/attempt-key.ts';
import type { AttemptEnd, AttemptStart, BrewerRunner } from '../../src/engine/brewer-runner.ts';
import { type CommandLog, createCommandLog } from '../../src/engine/command-log.ts';
import type { Ending } from '../../src/engine/decide.ts';
import {
  type Driver,
  type DriverEffects,
  type DriverNotice,
  type DriverOptions,
  openDriver,
} from '../../src/engine/driver.ts';
import type { EventStore } from '../../src/engine/event-store.ts';
import type { Recipe } from '../../src/engine/recipes.ts';
import { openSqliteEventStore } from '../../src/engine/sqlite-event-store.ts';
import { StateBranchStopError } from '../../src/engine/state-branch.ts';
import { defaultLimits } from '../helpers/brewing.ts';
import { fakeLock } from '../helpers/fake-lock.ts';
import { fakeRecipe, fakeRecipes } from '../helpers/fake-recipes.ts';

const minute = 60_000;
const t0 = new Date('2026-11-06T12:00:00.000Z');
const at = (minutes: number): Date => new Date(t0.getTime() + minutes * minute);
const succeeded: Ending = {
  kind: 'succeeded',
  output: { status: 'done', summary: 'Done', assumptions: [] },
};
const boom = new Error('boom');
const plan = (batchId: string, attempt = 1): AttemptRef => ({ batchId, stepId: 'plan', attempt });
const implement = (batchId: string): AttemptRef => ({ batchId, stepId: 'implement', attempt: 1 });

/** Attempts that run until the test ends them, and `stop`s that throw for what `stopThrows` says. */
const handRunner = (stopThrows: (ref: AttemptRef) => boolean = () => false) => {
  const running = new Map<string, (end: AttemptEnd) => void>();
  const started: AttemptRef[] = [];
  const stops: AttemptRef[] = [];
  const runner: BrewerRunner = {
    start: ({ ref }: AttemptStart) => {
      started.push(ref);
      const key = attemptKey.encode(ref);
      return {
        ended: new Promise<AttemptEnd>((resolve) => running.set(key, resolve)),
        stop: () => {
          stops.push(ref);
          if (stopThrows(ref)) throw boom;
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
  const end = (ref: AttemptRef, ending: Ending = succeeded): void => {
    const key = attemptKey.encode(ref);
    const resolve = running.get(key);
    assert.ok(resolve, `${key} runs`);
    running.delete(key);
    resolve({ ending });
  };
  return { runner, started, stops, end };
};

describe('one batch that throws in the driver (ADR 0328)', () => {
  let store: EventStore;
  let now: Date;
  let intake: CommandLog;
  let notices: DriverNotice[];
  // While true, the recipe `bad` throws when a deadline asks whether a step is interactive.
  let broken: boolean;
  const drivers: Driver[] = [];

  const pint = fakeRecipe({ steps: ['plan', 'implement'] });
  const bad: Recipe = {
    ...pint,
    interactive: (stepId) => {
      if (broken) throw boom;
      return pint.interactive(stepId);
    },
  };
  const recipes = fakeRecipes({ pint, bad });

  beforeEach(() => {
    store = openSqliteEventStore(':memory:');
    now = t0;
    intake = createCommandLog({ store, recipes });
    notices = [];
    broken = false;
  });
  afterEach(() => {
    for (const driver of drivers.splice(0)) driver.close();
    store.close();
  });

  /** Orders `batchId` and routes it to `recipe`: plan#1 is scheduled. */
  const order = (batchId: string, recipe = 'pint'): void => {
    const issue = Number(batchId.slice(1));
    assert.equal(intake.issue({ kind: 'order', batchId, order: { issue } }, now).kind, 'accepted');
    const route = { kind: 'route', batchId, recipe, reason: 'label', source: 'label' } as const;
    assert.equal(intake.issue(route, now).kind, 'accepted');
  };
  const open = async (options: Partial<DriverOptions> = {}): Promise<Driver> => {
    const driver = await openDriver({
      store,
      runner: handRunner().runner,
      recipes,
      clock: () => now,
      lock: () => fakeLock('cellar'),
      takes: () => true,
      stateBranch: { flush: async () => ({ kind: 'unchanged' }) },
      limits: () => defaultLimits,
      report: (notice) => notices.push(notice),
      ...options,
    });
    drivers.push(driver);
    return driver;
  };
  const failures = (): object[] =>
    notices.flatMap((notice): object[] =>
      notice.kind === 'batch_failed'
        ? [{ kind: notice.kind, batchId: notice.batchId, pass: notice.pass }]
        : notice.kind === 'batch_effects_failed'
          ? [{ kind: notice.kind, batchId: notice.batchId }]
          : [],
    );
  const laneOf = (driver: Driver, batchId: string) => driver.state().batches.get(batchId)?.lane;
  const expiredLease = (ref: AttemptRef, owner = 'gone'): string => {
    const key = attemptKey.encode(ref);
    store.withTransaction((tx) => tx.putLease({ attemptKey: key, owner, expiresAt: now }));
    return key;
  };
  /** Records the start of `ref` as a driver before this one would have. */
  const startedBefore = (ref: AttemptRef): void => {
    const event = { type: 'step.started', ...ref } as const;
    assert.equal(intake.issue({ kind: 'record', event }, now).kind, 'accepted');
  };

  describe('in drive', () => {
    it("a batch that throws in drive leaves the other batch's attempt started in the same tick", async () => {
      const { runner, started } = handRunner();
      order('b1');
      order('b2');
      const family = (ref: AttemptRef) => {
        if (ref.batchId === 'b1') throw boom;
        return undefined;
      };
      const driver = await open({ runner, family });
      await driver.tick();
      assert.deepStrictEqual(started, [plan('b2')]);
      assert.deepStrictEqual(failures(), [{ kind: 'batch_failed', batchId: 'b1', pass: 'drive' }]);
    });

    it('a drive with a batch that throws ends, and reports it once', async () => {
      const { runner, started } = handRunner();
      order('b1');
      order('b2');
      let asked = 0;
      // Past 50 it answers, so a drive that would ask for ever ends and fails the count below.
      const family = (ref: AttemptRef) => {
        if (ref.batchId === 'b1' && ++asked <= 50) throw boom;
        return undefined;
      };
      const driver = await open({ runner, family });
      await driver.drive();
      // b2's start is a move, so the drive passed over the batches again and set b1 aside there.
      assert.deepStrictEqual(started, [plan('b2')]);
      assert.equal(asked, 1);
      assert.equal(failures().length, 1);
    });

    it('tries a batch that threw again on the next drive, and starts it once it reads', async () => {
      const { runner, started } = handRunner();
      order('b1');
      let throws = true;
      const family = () => {
        if (throws) throw boom;
        return undefined;
      };
      const driver = await open({ runner, family });
      await driver.drive();
      assert.deepStrictEqual(started, []);
      throws = false;
      await driver.drive();
      assert.deepStrictEqual(started, [plan('b1')]);
    });

    it('an attempt whose runner start throws ends visibly: blocked on its environment, its lease gone', async () => {
      const { runner: hand, started } = handRunner();
      const runner: BrewerRunner = {
        ...hand,
        start: (attempt) => {
          if (attempt.ref.batchId === 'b1') throw boom;
          return hand.start(attempt);
        },
      };
      order('b1');
      order('b2');
      const driver = await open({ runner });
      await driver.tick();
      const lane = laneOf(driver, 'b1');
      assert.equal(lane?.kind, 'stuck');
      assert.equal(lane?.kind === 'stuck' && lane.reason.kind, 'blocked');
      const finished = store
        .eventsAfter(0)
        .map(({ event }) => event)
        .find((event) => event.type === 'step.finished' && event.batchId === 'b1');
      assert.deepStrictEqual(finished?.type === 'step.finished' && finished.outcome, {
        kind: 'failed',
        retryable: false,
        reason: 'blocked (environment): boom',
      });
      assert.deepStrictEqual(
        store.currentLeases(now).map(({ attemptKey: key }) => key),
        [attemptKey.encode(plan('b2'))],
      );
      assert.ok(notices.some((notice) => notice.kind === 'run_failed'));
      assert.deepStrictEqual(started, [plan('b2')]);
    });

    it("an attempt whose limits throw ends the same way, and the other batch's attempt starts", async () => {
      const { runner, started } = handRunner();
      order('b1');
      order('b2');
      const limits = (ref: AttemptRef) => {
        if (ref.batchId === 'b1') throw boom;
        return defaultLimits;
      };
      const driver = await open({ runner, limits });
      await driver.drive();
      assert.equal(laneOf(driver, 'b1')?.kind, 'stuck');
      assert.deepStrictEqual(started, [plan('b2')]);
    });

    it("an end whose reading throws is reported, and the pass's other ends are recorded", async () => {
      const { runner, end } = handRunner();
      order('b1');
      order('b2');
      const zone = () => {
        throw boom;
      };
      const driver = await open({ runner, zone });
      await driver.drive();
      const usageLimit = { limit: 'session', resets: '3:45pm' } as const;
      end(plan('b1'), { kind: 'blocked', blockerKind: 'environment', summary: 'out', usageLimit });
      end(plan('b2'));
      await driver.drive();
      assert.deepStrictEqual(failures(), [{ kind: 'batch_failed', batchId: 'b1', pass: 'drive' }]);
      assert.equal(driver.state().batches.get('b2')?.steps.get('implement')?.attempts.size, 1);
      // Its end is not recorded, so its lease stays until it expires and the supervisor loses it.
      assert.ok(
        store
          .currentLeases(now)
          .some(({ attemptKey: key }) => key === attemptKey.encode(plan('b1'))),
      );
    });

    it('a cleanup whose reading throws is reported and stays for the next drive, after the others', async () => {
      const { runner, started } = handRunner();
      order('b1');
      order('b2');
      // The lease list a cleanup reads first fails, the second time a drive reads the leases.
      let reads = Number.NEGATIVE_INFINITY;
      const faulty: EventStore = {
        ...store,
        currentLeases: (when) => {
          if (++reads === 2) throw boom;
          return store.currentLeases(when);
        },
      };
      const cleans: (string | undefined)[] = [];
      const clean = async (_: unknown, { batchId }: { batchId?: string }) => {
        cleans.push(batchId);
        return { done: [], kept: [], failed: [] };
      };
      const driver = await open({
        store: faulty,
        runner,
        alsoCleans: [{ root: 'settings', clean }],
      });
      assert.equal(
        intake.issue({ kind: 'cancel', batchId: 'b1', by: 'ada', via: 'terminal' }, now).kind,
        'accepted',
      );
      cleans.length = 0;
      reads = 0;
      await driver.drive();
      assert.deepStrictEqual(started, [plan('b2')]);
      assert.deepStrictEqual(failures(), [{ kind: 'batch_failed', batchId: 'b1', pass: 'drive' }]);
      assert.deepStrictEqual(cleans, []);
      await driver.drive();
      assert.deepStrictEqual(cleans, ['b1']);
    });

    it('a store fault on a batch another driver holds is not reported as its own', async () => {
      const { runner, started } = handRunner();
      order('b1');
      order('b2');
      store.withTransaction((tx) =>
        tx.putBatchLease({ batchId: 'b1', owner: 'session', expiresAt: at(5) }),
      );
      let fail = false;
      const faulty: EventStore = {
        ...store,
        withTransaction: (work) => {
          if (fail) {
            fail = false;
            throw boom;
          }
          return store.withTransaction(work);
        },
      };
      const driver = await open({ store: faulty, runner });
      fail = true;
      await driver.drive();
      assert.equal(fail, false, 'the fault came');
      assert.deepStrictEqual(started, [plan('b2')]);
      assert.deepStrictEqual(failures(), []);
    });

    it('a store fault on a batch this driver takes is reported', async () => {
      const { runner } = handRunner();
      order('b1');
      let fail = false;
      const faulty: EventStore = {
        ...store,
        withTransaction: (work) => {
          if (fail) {
            fail = false;
            throw boom;
          }
          return store.withTransaction(work);
        },
      };
      const driver = await open({ store: faulty, runner });
      fail = true;
      await driver.drive();
      assert.equal(fail, false, 'the fault came');
      assert.deepStrictEqual(failures(), [{ kind: 'batch_failed', batchId: 'b1', pass: 'drive' }]);
    });
  });

  describe("in the tick's pass over the runs", () => {
    it('a run whose stop throws leaves the other batch driven, and is stopped again on the next tick', async () => {
      const { runner, started, stops, end } = handRunner(({ batchId }) => batchId === 'b1');
      order('b1');
      order('b2');
      const driver = await open({ runner });
      await driver.drive();
      assert.equal(
        intake.issue({ kind: 'cancel', batchId: 'b1', by: 'ada', via: 'terminal' }, now).kind,
        'accepted',
      );
      end(plan('b2'));
      await driver.tick();
      assert.deepStrictEqual(started, [plan('b1'), plan('b2'), implement('b2')]);
      assert.deepStrictEqual(failures(), [{ kind: 'batch_failed', batchId: 'b1', pass: 'runs' }]);
      assert.deepStrictEqual(stops, [plan('b1')]);
      await driver.tick();
      assert.deepStrictEqual(stops, [plan('b1'), plan('b1')]);
    });

    it('a close whose first stop throws stops the other runs and lets the lock go', async () => {
      const { runner, stops } = handRunner(({ batchId }) => batchId === 'b1');
      order('b1');
      order('b2');
      let released = 0;
      const lock = () => ({
        ...fakeLock('cellar'),
        release: () => {
          released++;
        },
      });
      const driver = await open({ runner, lock });
      await driver.drive();
      drivers.splice(0);
      driver.close();
      assert.deepStrictEqual(stops, [plan('b1'), plan('b2')]);
      assert.equal(released, 1);
    });

    it("a run whose stop at its pause's stopAt throws is stopped again on the next tick", async () => {
      let throws = true;
      const { runner, stops } = handRunner(() => throws);
      order('b1');
      const driver = await open({ runner });
      await driver.drive();
      const pause = {
        kind: 'pause',
        order: { issue: 1 },
        by: 'ada',
        via: 'terminal',
        stopAt: { at: at(1), zone: 'UTC' },
      } as const;
      assert.equal(intake.issue(pause, now).kind, 'accepted');
      now = at(2);
      await driver.tick();
      assert.deepStrictEqual(stops, [plan('b1')]);
      throws = false;
      await driver.tick();
      assert.deepStrictEqual(stops, [plan('b1'), plan('b1')]);
      // It ended as its pause stopped it: no attempt of it is spent, and no failure said.
      await driver.tick();
      assert.equal(stops.length, 2);
    });
  });

  describe('in the supervisor', () => {
    it("a batch that throws in the supervisor loses no other batch's deadline", async () => {
      const { runner } = handRunner();
      order('b1', 'bad');
      order('b2');
      const driver = await open({ runner });
      await driver.drive();
      broken = true;
      now = at(61);
      await driver.tick();
      assert.equal(laneOf(driver, 'b2')?.kind, 'stuck');
      assert.equal(laneOf(driver, 'b1')?.kind, 'brewing');
      assert.deepStrictEqual(failures(), [
        { kind: 'batch_failed', batchId: 'b1', pass: 'supervisor' },
      ]);
    });

    it('a batch that threw in the supervisor meets its deadline once it reads', async () => {
      const { runner } = handRunner();
      order('b1', 'bad');
      const driver = await open({ runner });
      await driver.drive();
      broken = true;
      now = at(61);
      await driver.tick();
      broken = false;
      now = at(62);
      await driver.tick();
      assert.equal(laneOf(driver, 'b1')?.kind, 'stuck');
    });

    it('an expired lease whose batch cannot be read stays for the next tick', async () => {
      const { runner } = handRunner();
      order('b1', 'bad');
      order('b2');
      const driver = await open({ runner, takes: () => false });
      startedBefore(plan('b1'));
      startedBefore(plan('b2'));
      const sick = expiredLease(plan('b1'));
      const well = expiredLease(plan('b2'));
      broken = true;
      // Past both deadlines: the deadline's reading is what throws of b1.
      now = at(61);
      await driver.tick();
      const left = store.expiredLeases(now).map(({ attemptKey: key }) => key);
      assert.ok(left.includes(sick), 'its lease stays');
      assert.ok(!left.includes(well), "the other batch's goes");
      assert.equal(laneOf(driver, 'b2')?.kind, 'stuck');
      broken = false;
      await driver.tick();
      assert.equal(laneOf(driver, 'b1')?.kind, 'stuck');
      assert.deepStrictEqual(store.expiredLeases(now), []);
    });

    it('a lost attempt whose lose throws keeps its lease for the next tick', async () => {
      let refuses = true;
      const unreadable: Recipe = {
        ...pint,
        mayRetry: (batch, stepId) => {
          if (refuses) throw boom;
          return pint.mayRetry(batch, stepId);
        },
      };
      const those = fakeRecipes({ pint, unreadable });
      const log = createCommandLog({ store, recipes: those });
      const route = (batchId: string, recipe: string) => {
        const issue = Number(batchId.slice(1));
        log.issue({ kind: 'order', batchId, order: { issue } }, now);
        log.issue({ kind: 'route', batchId, recipe, reason: 'label', source: 'label' }, now);
      };
      route('b1', 'unreadable');
      route('b2', 'pint');
      const driver = await open({ recipes: those, takes: () => false });
      startedBefore(plan('b1'));
      startedBefore(plan('b2'));
      const sick = expiredLease(plan('b1'));
      const well = expiredLease(plan('b2'));
      await driver.tick();
      const left = store.expiredLeases(now).map(({ attemptKey: key }) => key);
      assert.deepStrictEqual(left, [sick]);
      assert.ok(!left.includes(well));
      assert.ok(notices.some((notice) => notice.kind === 'command_failed'));
      refuses = false;
      await driver.tick();
      assert.deepStrictEqual(store.expiredLeases(now), []);
      const scheduled = driver.state().batches.get('b1')?.steps.get('plan')?.attempts.size;
      assert.equal(scheduled, 2, 'lost, and retried');
    });

    it('a state-branch stop still rejects the tick (regression test)', async () => {
      const stop = new StateBranchStopError('another engine pushed');
      const driver = await open({
        stateBranch: {
          flush: async () => {
            throw stop;
          },
        },
      });
      await assert.rejects(driver.tick(), (error) => error === stop);
    });

    it('a state-branch stop still rejects the tick when a batch threw in it', async () => {
      const stop = new StateBranchStopError('another engine pushed');
      const { runner } = handRunner();
      order('b1', 'bad');
      const driver = await open({
        runner,
        stateBranch: {
          flush: async () => {
            throw stop;
          },
        },
      });
      await driver.drive();
      broken = true;
      now = at(61);
      await assert.rejects(driver.tick(), (error) => error === stop);
      assert.deepStrictEqual(failures(), [
        { kind: 'batch_failed', batchId: 'b1', pass: 'supervisor' },
      ]);
    });

    it('a lost batch is still lost, with no failure said (regression test)', async () => {
      const { runner, started } = handRunner();
      order('b1');
      const driver = await open({ runner });
      await driver.drive();
      store.withTransaction((tx) =>
        tx.putBatchLease({ batchId: 'b1', owner: 'session', expiresAt: at(5) }),
      );
      await driver.tick();
      assert.ok(notices.some((notice) => notice.kind === 'batch_lost'));
      assert.deepStrictEqual(failures(), []);
      assert.deepStrictEqual(started, [plan('b1')]);
    });
  });

  describe('in the effects', () => {
    const throwingFor = (batchId: string): DriverEffects => ({
      due: (_state, id) => {
        if (id === batchId) throw boom;
        return [];
      },
      target: {
        find: async () => undefined,
        apply: async () => ({}),
      },
    });

    it('a driver that does not take the batch says nothing of its effects', async () => {
      order('b1');
      const driver = await open({ takes: () => false, effects: throwingFor('b1') });
      await driver.tick();
      assert.deepStrictEqual(failures(), []);
    });

    it('a driver says nothing of the effects of a batch another driver holds', async () => {
      order('b1');
      store.withTransaction((tx) =>
        tx.putBatchLease({ batchId: 'b1', owner: 'session', expiresAt: at(5) }),
      );
      const driver = await open({ effects: throwingFor('b1') });
      await driver.applyEffects();
      assert.deepStrictEqual(failures(), []);
    });

    it('a driver reports the effects of a batch it takes (regression test)', async () => {
      order('b1');
      const driver = await open({ effects: throwingFor('b1') });
      await driver.applyEffects();
      assert.deepStrictEqual(failures(), [{ kind: 'batch_effects_failed', batchId: 'b1' }]);
    });
  });
});
