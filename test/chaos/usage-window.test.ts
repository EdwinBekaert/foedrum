// A driver killed while the usage window is closed, then the reopen (#242, ADR 0206): batches brew,
// one attempt hits claude's usage limit, and the driver is killed at a random tick and started
// again while the window is closed. No brewer attempt starts until the reopen, whatever the kill,
// and after it every batch is on tap: no deadline the window outlasted makes it Stuck, and no
// attempt the limit ended uses up its step. The run count is FOEDRUM_RUNS (a few in npm run check,
// more in CI).

import assert from 'node:assert/strict';
import { it } from 'node:test';
import { type AttemptRef, attemptKey } from '../../src/engine/attempt-key.ts';
import type { AttemptEnd, BrewerRunner } from '../../src/engine/brewer-runner.ts';
import { type CommandLog, createCommandLog } from '../../src/engine/command-log.ts';
import type { Command, Ending } from '../../src/engine/decide.ts';
import { type Driver, openDriver } from '../../src/engine/driver.ts';
import type { EventStore } from '../../src/engine/event-store.ts';
import { openSqliteEventStore } from '../../src/engine/sqlite-event-store.ts';
import { defaultLimits } from '../helpers/brewing.ts';
import { seededRandom } from '../helpers/event-sequences.ts';
import { fakeLock } from '../helpers/fake-lock.ts';
import { fakeRecipe, fakeRecipes } from '../helpers/fake-recipes.ts';
import { forEachSeedAsync } from '../helpers/property.ts';

const minute = 60_000;
const t0 = new Date('2026-10-26T09:00:00.000Z');
// Each step may run twice: one loss to the kill, and the attempt the limit ended, which counts not.
const recipes = fakeRecipes({ pint: fakeRecipe({ steps: ['plan', 'implement'], maxAttempts: 2 }) });
const succeeded: Ending = {
  kind: 'succeeded',
  output: { status: 'done', summary: 'Done', assumptions: [] },
};
const limited: Ending = {
  kind: 'blocked',
  blockerKind: 'environment',
  summary: 'claude hit its weekly limit, which resets 3:45pm',
  usageLimit: { limit: 'weekly', resets: '3:45pm' },
};

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
  /** Ends each running attempt for which `pick` says so, with what `ending` gives. */
  const endSome = (pick: () => boolean, ending: () => Ending = () => succeeded): void => {
    for (const [key, { end }] of [...running]) {
      if (!pick()) continue;
      running.delete(key);
      end({ ending: ending() });
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
      zone: () => 'UTC',
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
    // At most one step on: every batch still has a step to brew.
    for (let each = random.int(2); each > 0; each--) {
      await tick();
      attempts.endSome(() => random.chance(0.3));
    }
    // One running attempt hits the limit; the others still run.
    for (let each = 0; log.state().usageWindow === undefined; each++) {
      assert.ok(each < 5, 'an attempt hits the limit');
      await tick();
      let ended = 0;
      attempts.endSome(
        () => ++ended === 1,
        () => limited,
      );
    }
    const window = log.state().usageWindow;
    assert.ok(window);
    const closedAfter = store.lastEventId();

    // While it is closed, what still runs ends, maybe at the limit too, and the driver is killed.
    const killAt = random.int(6);
    const reopen = Date.parse(window.reopensAt);
    for (let each = 0; now.getTime() + minute < reopen; each++) {
      if (each === killAt) {
        // Its runs' ends are not recorded: the restarted driver loses them.
        driver.close();
        attempts = runner();
        driver = await open();
      }
      await tick();
      attempts.endSome(
        () => random.chance(0.3),
        () => (random.chance(0.3) ? limited : succeeded),
      );
      // Past what runs: on to just before the reopen.
      const skip = reopen - 2 * minute;
      if (attempts.count() === 0 && each > killAt && now.getTime() < skip) now = new Date(skip);
    }
    const startedWhileClosed = store
      .eventsAfter(closedAfter)
      .map(({ event }) => event)
      .filter((event) => event.type === 'step.started');
    assert.deepStrictEqual(startedWhileClosed, [], 'no brewer started while the window was closed');

    for (let each = 0; each < 40; each++) {
      await tick();
      attempts.endSome(() => true);
      const lanes = [...log.state().batches.values()].map(({ lane }) => lane.kind);
      if (lanes.every((lane) => lane === 'on_tap')) break;
    }
    assert.equal(log.state().usageWindow, undefined, 'the window reopened');
    for (const { id, lane } of log.state().batches.values()) {
      assert.equal(lane.kind, 'on_tap', `${id} is on tap after the reopen`);
    }
  } finally {
    driver.close();
    store.close();
  }
};

it('a driver killed while the usage window is closed starts no brewer, and every batch is on tap after the reopen', () =>
  forEachSeedAsync(30, run));
