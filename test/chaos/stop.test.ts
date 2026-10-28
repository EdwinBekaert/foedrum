// A stop during an attempt, a kill during a stop, and a retry (#518, ADR 0205): batches brew, a
// person stops one order at a random tick, and the driver may be killed and started again before
// its next tick. The driver that ran them stops the stopped order's runs by that next tick,
// nothing of it starts until its retry, and once retried every stopped batch is on tap. The run count is FOEDRUM_RUNS
// (a few in npm run check, more in CI).

import assert from 'node:assert/strict';
import { it } from 'node:test';
import { seededRandom } from '../helpers/event-sequences.ts';
import { fakeRecipe, fakeRecipes } from '../helpers/fake-recipes.ts';
import { handDrivenRun } from '../helpers/hand-driven.ts';
import { forEachSeedAsync } from '../helpers/property.ts';

const t0 = new Date('2026-10-26T16:00:00.000Z');
// Each step may run twice: one loss to the kill, or the stopped attempt, which counts; a person's
// retry schedules the step whatever attempts it has left (ADR 0205).
const recipes = fakeRecipes({ pint: fakeRecipe({ steps: ['plan', 'implement'], maxAttempts: 2 }) });
const who = { by: 'ada', via: 'terminal' } as const;

const run = async (seed: number): Promise<void> => {
  const random = seededRandom(seed);
  const hand = await handDrivenRun({ t0, recipes });
  const { store, log, accept, tick } = hand;
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
      hand.endSome(() => random.chance(0.3));
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
    const restarted = random.chance(0.5);
    if (restarted) {
      await hand.restart();
    }
    await tick();
    // A restarted driver's runner is new: only the one that ran them can show their runs stopped;
    // after a restart, the check below that nothing stopped starts holds the line.
    if (!restarted) {
      assert.equal(hand.runsOf(stopped), 0, 'the next tick stopped what ran of the order');
    }
    for (let each = 0; each < 5; each++) {
      hand.endSome(() => random.chance(0.3));
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
      hand.endSome(() => true);
      const lanes = [...stopped].map((batchId) => log.state().batches.get(batchId)?.lane.kind);
      if (lanes.every((lane) => lane === 'on_tap')) break;
    }
    for (const batchId of stopped) {
      const lane = log.state().batches.get(batchId)?.lane.kind;
      assert.equal(lane, 'on_tap', `${batchId} is on tap once retried`);
    }
  } finally {
    hand.close();
  }
};

it('a stop during an attempt, with a kill or not, stops its runs, and a retry brings it on tap', () =>
  forEachSeedAsync(30, run));
