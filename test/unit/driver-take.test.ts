// A throw while the driver takes one batch stops no other batch's take in the tick (#1181, ADR 0435,
// ADR 0328): two batches on an in-memory store, and a recipe whose deadline throws for one of them.

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { type AttemptRef, attemptKey } from '../../src/engine/attempt-key.ts';
import type { AttemptEnd, AttemptStart, BrewerRunner } from '../../src/engine/brewer-runner.ts';
import { type CommandLog, createCommandLog } from '../../src/engine/command-log.ts';
import { type Driver, type DriverNotice, openDriver } from '../../src/engine/driver.ts';
import type { EventStore } from '../../src/engine/event-store.ts';
import type { Recipe } from '../../src/engine/recipes.ts';
import { openSqliteEventStore } from '../../src/engine/sqlite-event-store.ts';
import { defaultLimits } from '../helpers/brewing.ts';
import { fakeLock } from '../helpers/fake-lock.ts';
import { fakeRecipe, fakeRecipes } from '../helpers/fake-recipes.ts';

const minute = 60_000;
const t0 = new Date('2026-11-06T12:00:00.000Z');
const at = (minutes: number): Date => new Date(t0.getTime() + minutes * minute);
const plan = (batchId: string): AttemptRef => ({ batchId, stepId: 'plan', attempt: 1 });
const boom = new Error('boom');

describe('one batch that throws as the driver takes it (#1181, ADR 0435)', () => {
  let store: EventStore;
  let now: Date;
  let intake: CommandLog;
  let notices: DriverNotice[];
  let started: AttemptRef[];
  // While true, the recipe `bad` throws when the deadline of a step is asked for.
  let broken: boolean;
  const drivers: Driver[] = [];

  const pint = fakeRecipe({ steps: ['plan'] });
  const bad: Recipe = {
    ...pint,
    deadlineMs: (stepId) => {
      if (broken) throw boom;
      return pint.deadlineMs(stepId);
    },
  };
  const recipes = fakeRecipes({ pint, bad });
  const runner: BrewerRunner = {
    start: ({ ref }: AttemptStart) => {
      started.push(ref);
      return { ended: new Promise<AttemptEnd>(() => {}), stop: () => {} };
    },
    progress: (ref) =>
      started.some((one) => attemptKey.encode(one) === attemptKey.encode(ref))
        ? { lastProgressAt: t0, turnsWithoutProgress: 0 }
        : undefined,
  };

  beforeEach(() => {
    store = openSqliteEventStore(':memory:');
    now = t0;
    intake = createCommandLog({ store, recipes });
    notices = [];
    started = [];
    broken = false;
  });
  afterEach(() => {
    for (const driver of drivers.splice(0)) driver.close();
    store.close();
  });

  const order = (batchId: string, recipe: string): void => {
    const issue = Number(batchId.slice(1));
    assert.equal(intake.issue({ kind: 'order', batchId, order: { issue } }, now).kind, 'accepted');
    const route = { kind: 'route', batchId, recipe, reason: 'label', source: 'label' } as const;
    assert.equal(intake.issue(route, now).kind, 'accepted');
  };
  const rescheduledBatches = (): string[] =>
    store
      .eventsAfter(0)
      .flatMap(({ event }) => (event.type === 'step.rescheduled' ? [event.batchId] : []));

  it('reports it, and takes the other batch in the same tick', async () => {
    order('b1', 'bad');
    order('b2', 'pint');
    broken = true;
    // Past the one-hour deadline b1's attempt was scheduled with.
    now = at(200);
    const driver = await openDriver({
      store,
      runner,
      recipes,
      clock: () => now,
      lock: () => fakeLock('cellar'),
      takes: () => true,
      stateBranch: { flush: async () => ({ kind: 'unchanged' }) },
      limits: () => defaultLimits,
      report: (notice) => notices.push(notice),
    });
    drivers.push(driver);
    await driver.tick();
    assert.deepStrictEqual(rescheduledBatches(), ['b2']);
    // The batch whose take threw keeps its old deadline, which has passed: it is neither expired
    // nor started in this tick.
    assert.deepStrictEqual(started, [plan('b2')]);
    assert.equal(driver.state().batches.get('b1')?.lane.kind, 'brewing');
    assert.deepStrictEqual(
      notices.flatMap((notice) =>
        notice.kind === 'batch_failed'
          ? [{ batchId: notice.batchId, pass: notice.pass, error: notice.error }]
          : [],
      ),
      [{ batchId: 'b1', pass: 'supervisor', error: boom }],
    );
    // The next take tries it again, and its attempt starts under the new deadline.
    broken = false;
    await driver.tick();
    assert.deepStrictEqual(rescheduledBatches(), ['b2', 'b1']);
    assert.deepStrictEqual(started, [plan('b2'), plan('b1')]);
    assert.equal(driver.state().batches.get('b1')?.lane.kind, 'brewing');
  });
});
