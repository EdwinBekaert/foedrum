// A stop during an attempt, a kill during a stop, and a retry (#518, ADR 0205): batches brew, a
// person stops one order at a random tick, and the driver may be killed and started again before
// its next tick. The stopped order's runs are stopped by that next tick, nothing of it starts
// until its retry, and once retried every stopped batch is on tap. The run count is FOEDRUM_RUNS
// (a few in npm run check, more in CI).

import assert from 'node:assert/strict';
import { it } from 'node:test';
import { type AttemptRef, attemptKey } from '../../src/engine/attempt-key.ts';
import type { AttemptEnd, BrewerRunner } from '../../src/engine/brewer-runner.ts';
import { type CommandLog, createCommandLog } from '../../src/engine/command-log.ts';
import type { Command } from '../../src/engine/decide.ts';
import { type Driver, openDriver } from '../../src/engine/driver.ts';
import type { EventStore } from '../../src/engine/event-store.ts';
import { openSqliteEventStore } from '../../src/engine/sqlite-event-store.ts';
import { defaultLimits } from '../helpers/brewing.ts';
import { seededRandom } from '../helpers/event-sequences.ts';
import { fakeLock } from '../helpers/fake-lock.ts';
import { fakeRecipe, fakeRecipes } from '../helpers/fake-recipes.ts';
import { forEachSeedAsync } from '../helpers/property.ts';

const minute = 60_000;
const t0 = new Date('2026-10-26T16:00:00.000Z');
// Each step may run twice: one loss to the kill; the stopped attempt spends none.
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
  const runsOf = (batchIds: ReadonlySet<string>): number =>
    [...running.values()].filter(({ ref }) => batchIds.has(ref.batchId)).length;
  return { brewer, endSome, runsOf };
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
    // Brew until an attempt runs, so the stop comes during one.
    await tick();
    for (let each = random.int(4); each > 0; each--) {
      attempts.endSome(() => random.chance(0.3));
      await tick();
    }
    const brewing = [...log.state().batches.values()].filter(({ lane }) => lane.kind === 'brewing');
    if (brewing.length === 0) return;
    const { issue } = random.pick(brewing);

    // The stop, and maybe a kill before the driver's next tick.
    accept({ kind: 'stop', order: { issue }, ...who, why: 'wrong way' });
    const stoppedAfter = store.lastEventId();
    const stopped = new Set(
      [...log.state().batches.values()]
        .filter(({ lane }) => lane.kind === 'stuck' && lane.reason.kind === 'stopped')
        .map(({ id }) => id),
    );
    assert.ok(stopped.size > 0, 'the stop made a batch Stuck');
    if (random.chance(0.5)) {
      // Its runs' ends are not recorded: the restarted driver loses them.
      driver.close();
      attempts = runner();
      driver = await open();
    }
    await tick();
    assert.equal(attempts.runsOf(stopped), 0, 'the next tick stopped what ran of the order');
    for (let each = 0; each < 5; each++) {
      attempts.endSome(() => random.chance(0.3));
      await tick();
    }
    const startedWhileStopped = store
      .eventsAfter(stoppedAfter)
      .map(({ event }) => event)
      .filter((event) => event.type === 'step.started' && stopped.has(event.batchId));
    assert.deepStrictEqual(startedWhileStopped, [], 'nothing stopped started before its retry');
    for (const batchId of stopped) {
      assert.equal(log.state().batches.get(batchId)?.lane.kind, 'stuck', `${batchId} waits`);
    }

    for (const batchId of stopped) accept({ kind: 'retry', batchId, ...who });
    for (let each = 0; each < 60; each++) {
      await tick();
      attempts.endSome(() => true);
      const lanes = [...stopped].map((batchId) => log.state().batches.get(batchId)?.lane.kind);
      if (lanes.every((lane) => lane === 'on_tap')) break;
    }
    for (const batchId of stopped) {
      const lane = log.state().batches.get(batchId)?.lane.kind;
      assert.equal(lane, 'on_tap', `${batchId} is on tap once retried`);
    }
  } finally {
    driver.close();
    store.close();
  }
};

it('a stop during an attempt, with a kill or not, stops its runs, and a retry brings it on tap', () =>
  forEachSeedAsync(30, run));
