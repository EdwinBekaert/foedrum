// A driver killed during a pause, then continued (#241, ADR 0202): batches brew, a person pauses
// one order or the whole Brewery, maybe with --by, and the driver is killed at a random tick and
// started again while the pause holds; the night passes. Nothing held starts while it is paused,
// whatever the kill, and once continued every batch is on tap: no deadline the pause outlasted
// makes it Stuck, and no attempt the pause stopped uses up its step. The run count is FOEDRUM_RUNS
// (a few in npm run check, more in CI).

import assert from 'node:assert/strict';
import { it } from 'node:test';
import { type AttemptRef, attemptKey } from '../../src/engine/attempt-key.ts';
import type { AttemptEnd, BrewerRunner } from '../../src/engine/brewer-runner.ts';
import { type CommandLog, createCommandLog } from '../../src/engine/command-log.ts';
import type { Command } from '../../src/engine/decide.ts';
import { type Driver, openDriver } from '../../src/engine/driver.ts';
import type { EventStore } from '../../src/engine/event-store.ts';
import { pauseOf } from '../../src/engine/pauses.ts';
import { openSqliteEventStore } from '../../src/engine/sqlite-event-store.ts';
import { defaultLimits } from '../helpers/brewing.ts';
import { seededRandom } from '../helpers/event-sequences.ts';
import { fakeLock } from '../helpers/fake-lock.ts';
import { fakeRecipe, fakeRecipes } from '../helpers/fake-recipes.ts';
import { forEachSeedAsync } from '../helpers/property.ts';

const minute = 60_000;
const t0 = new Date('2026-10-26T16:00:00.000Z');
// Each step may run twice: one loss to the kill, and an attempt the pause stopped, which counts not.
const recipes = fakeRecipes({ pint: fakeRecipe({ steps: ['plan', 'implement'], maxAttempts: 2 }) });
const who = { by: 'ada', via: 'terminal' } as const;

/** A runner whose attempts end when the test says; a stopped one ends cancelled. */
const runner = () => {
  const running = new Map<string, { ref: AttemptRef; end: (end: AttemptEnd) => void }>();
  const brewer: BrewerRunner = {
    start: ({ ref }) => {
      const key = attemptKey.encode(ref);
      const ended = new Promise<AttemptEnd>((end) => running.set(key, { ref, end }));
      return {
        ended,
        stop: () => {
          running.get(key)?.end({ ending: { kind: 'cancelled' } });
          running.delete(key);
        },
      };
    },
    progress: (ref) =>
      running.has(attemptKey.encode(ref))
        ? { lastProgressAt: t0, turnsWithoutProgress: 0 }
        : undefined,
  };
  /** Ends each running attempt for which `pick` says so, succeeded. */
  const endSome = (pick: () => boolean): void => {
    for (const [key, { end }] of [...running]) {
      if (!pick()) continue;
      running.delete(key);
      end({
        ending: { kind: 'succeeded', output: { status: 'done', summary: 'Done', assumptions: [] } },
      });
    }
  };
  return { brewer, endSome, count: () => running.size };
};

const run = async (seed: number): Promise<void> => {
  const random = seededRandom(seed);
  const store: EventStore = openSqliteEventStore(':memory:');
  let now = t0;
  const log: CommandLog = createCommandLog({ store, recipes });
  const accept = (command: Command): void => {
    const decision = log.issue(command, now);
    assert.equal(decision.kind, 'accepted', JSON.stringify(decision));
  };
  let attempts = runner();
  const open = (): Promise<Driver> =>
    openDriver({
      store,
      runner: attempts.brewer,
      recipes,
      clock: () => now,
      lock: () => fakeLock('cellar'),
      takes: () => true,
      stateBranch: { flush: async () => ({ kind: 'unchanged' }) },
      limits: () => defaultLimits,
    });
  let driver = await open();
  const tick = async (): Promise<void> => {
    now = new Date(now.getTime() + minute);
    await driver.tick();
  };
  try {
    const count = 1 + random.int(3);
    for (let issue = 1; issue <= count; issue++) {
      const batchId = `b${issue}`;
      accept({ kind: 'order', batchId, order: { issue } });
      accept({ kind: 'route', batchId, recipe: 'pint', reason: 'label', source: 'label' });
    }
    for (let each = random.int(4); each > 0; each--) {
      await tick();
      attempts.endSome(() => random.chance(0.3));
    }

    // The pause: one order or all of them, with --by or without.
    const order = random.chance(0.5) ? { order: { issue: 1 + random.int(count) } } : {};
    const stopAt = random.chance(0.5)
      ? { stopAt: { at: new Date(now.getTime() + random.int(5) * minute), zone: 'UTC' } }
      : {};
    accept({ kind: 'pause', ...order, ...who, ...stopAt });
    const pausedAfter = store.lastEventId();
    const held = new Set(
      [...log.state().batches.values()]
        .filter((batch) => pauseOf(log.state(), batch) !== undefined)
        .map((batch) => batch.id),
    );

    // Until what runs of the held batches has ended, at its point or at --by, killed on the way.
    const killAt = random.int(6);
    for (let each = 0; each < 30; each++) {
      if (each === killAt) {
        // Its runs' ends are not recorded: the restarted driver loses them.
        driver.close();
        attempts = runner();
        driver = await open();
      }
      await tick();
      attempts.endSome(() => random.chance(0.3));
      if (attempts.count() === 0 && each > killAt) break;
    }
    // The night: longer than any step's deadline.
    now = new Date(now.getTime() + 14 * 60 * minute);
    await tick();
    await tick();

    const startedWhilePaused = store
      .eventsAfter(pausedAfter)
      .map(({ event }) => event)
      .filter((event) => event.type === 'step.started' && held.has(event.batchId));
    assert.deepStrictEqual(startedWhilePaused, [], 'nothing held started while paused');
    for (const batchId of held) {
      const lane = log.state().batches.get(batchId)?.lane.kind;
      assert.equal(lane, 'brewing', `${batchId} waits paused, neither Stuck nor ended`);
    }

    accept({ kind: 'continue', ...order, ...who });
    for (let each = 0; each < 40; each++) {
      await tick();
      attempts.endSome(() => true);
      const lanes = [...held].map((batchId) => log.state().batches.get(batchId)?.lane.kind);
      if (lanes.every((lane) => lane === 'on_tap')) break;
    }
    // The batches it did not hold brewed through the night as they would have, and may be Stuck.
    for (const batchId of held) {
      const lane = log.state().batches.get(batchId)?.lane.kind;
      assert.equal(lane, 'on_tap', `${batchId} is on tap once continued`);
    }
  } finally {
    driver.close();
    store.close();
  }
};

it('a driver killed during a pause starts nothing held, and every batch is on tap once continued', () =>
  forEachSeedAsync(30, run));
