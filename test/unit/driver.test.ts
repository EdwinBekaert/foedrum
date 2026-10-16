// The driver (ADR 0019, ADR 0033, ADR 0037): its lock and start come before any work, it holds the
// lease of every batch it drives and renews it, skips the batches another driver holds, stops at
// the next step boundary when it loses one, and applies a batch's effects only while it holds it.
// An in-memory store, a runner the test ends by hand, and a second command log for the intake and
// the other writers.

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { type AttemptRef, attemptKey } from '../../src/engine/attempt-key.ts';
import type { AttemptEnd, AttemptStart, BrewerRunner } from '../../src/engine/brewer-runner.ts';
import { type CommandLog, createCommandLog } from '../../src/engine/command-log.ts';
import type { Ending } from '../../src/engine/decide.ts';
import { type Driver, type DriverOptions, openDriver } from '../../src/engine/driver.ts';
import { DriverRunningError } from '../../src/engine/driver-lock.ts';
import type { EffectTarget } from '../../src/engine/effects.ts';
import type { EffectKey, EventStore } from '../../src/engine/event-store.ts';
import type { State } from '../../src/engine/fold.ts';
import { openSqliteEventStore } from '../../src/engine/sqlite-event-store.ts';
import type { Event } from '../../src/schemas/events.ts';
import { defaultLimits } from '../helpers/brewing.ts';
import { fakeLock } from '../helpers/fake-lock.ts';
import { fakeRecipe, fakeRecipes } from '../helpers/fake-recipes.ts';

const minute = 60_000;
const t0 = new Date('2026-10-15T12:00:00.000Z');
const at = (minutes: number): Date => new Date(t0.getTime() + minutes * minute);
const recipes = fakeRecipes({ pint: fakeRecipe({ steps: ['plan', 'implement'] }) });
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
});
