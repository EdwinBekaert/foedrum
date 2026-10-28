// A driver killed during a pause, then continued (#241, ADR 0202): batches brew, a person pauses
// one order or the whole Brewery, maybe with --by, and the driver is killed at a random tick and
// started again while the pause holds; the night passes. Nothing held starts while it is paused,
// whatever the kill, and once continued every batch is on tap: no deadline the pause outlasted
// makes it Stuck, and no attempt the pause stopped uses up its step. The run count is FOEDRUM_RUNS
// (a few in npm run check, more in CI).

import assert from 'node:assert/strict';
import { it } from 'node:test';
import { pauseOf } from '../../src/engine/pauses.ts';
import { seededRandom } from '../helpers/event-sequences.ts';
import { fakeRecipe, fakeRecipes } from '../helpers/fake-recipes.ts';
import { handDrivenRun } from '../helpers/hand-driven.ts';
import { forEachSeedAsync } from '../helpers/property.ts';

const minute = 60_000;
const t0 = new Date('2026-10-26T16:00:00.000Z');
// Each step may run twice: one loss to the kill, and an attempt the pause stopped, which counts not.
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
    for (let each = random.int(4); each > 0; each--) {
      await tick();
      hand.endSome(() => random.chance(0.3));
    }

    // The pause: one order or all of them, with --by or without.
    // A pause holds only an order with a batch that has not ended; else it is --all.
    const live = [...log.state().batches.values()].filter(
      ({ lane }) => lane.kind !== 'on_tap' && lane.kind !== 'cancelled',
    );
    const one = live.length > 0 && random.chance(0.5) ? random.pick(live) : undefined;
    const order = one === undefined ? {} : { order: { issue: one.issue } };
    const stopAt = random.chance(0.5)
      ? { stopAt: { at: new Date(hand.now().getTime() + random.int(5) * minute), zone: 'UTC' } }
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
        await hand.restart();
      }
      await tick();
      hand.endSome(() => random.chance(0.3));
      if (hand.count() === 0 && each > killAt) break;
    }
    // The night: longer than any step's deadline.
    hand.skipTo(new Date(hand.now().getTime() + 14 * 60 * minute));
    await tick();
    await tick();

    const startedWhilePaused = store
      .eventsAfter(pausedAfter)
      .map(({ event }) => event)
      .filter((event) => event.type === 'step.started' && held.has(event.batchId));
    assert.deepStrictEqual(startedWhilePaused, [], 'nothing held started while paused');
    for (const batchId of held) {
      const lane = log.state().batches.get(batchId)?.lane.kind;
      // A batch whose last step ended at its own point during the pause is on tap.
      assert.ok(lane === 'brewing' || lane === 'on_tap', `${batchId} is ${lane} while paused`);
    }

    accept({ kind: 'continue', ...order, ...who });
    for (let each = 0; each < 40; each++) {
      await tick();
      hand.endSome(() => true);
      const lanes = [...held].map((batchId) => log.state().batches.get(batchId)?.lane.kind);
      if (lanes.every((lane) => lane === 'on_tap')) break;
    }
    // The batches it did not hold brewed through the night as they would have, and may be Stuck.
    for (const batchId of held) {
      const lane = log.state().batches.get(batchId)?.lane.kind;
      assert.equal(lane, 'on_tap', `${batchId} is on tap once continued`);
    }
  } finally {
    hand.close();
  }
};

it('a driver killed during a pause starts nothing held, and every batch is on tap once continued', () =>
  forEachSeedAsync(30, run));
