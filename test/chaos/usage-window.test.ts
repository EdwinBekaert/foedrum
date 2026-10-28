// A driver killed while the usage window is closed, then the reopen (#242, ADR 0206): batches brew,
// one attempt hits claude's usage limit, and the driver is killed at a random tick and started
// again while the window is closed. No brewer attempt the window holds starts until the reopen,
// whatever the kill, and after it every batch is on tap: no deadline the window outlasted makes it
// Stuck, and no attempt the limit ended uses up its step. With an Opus limit only the Opus brewers
// wait; the Sonnet ones go on (ADR 0215). The run count is FOEDRUM_RUNS (a few in npm run check,
// more in CI).

import assert from 'node:assert/strict';
import { it } from 'node:test';
import type { AttemptRef } from '../../src/engine/attempt-key.ts';
import type { Ending } from '../../src/engine/decide.ts';
import type { ModelFamily } from '../../src/engine/usage-window.ts';
import { seededRandom } from '../helpers/event-sequences.ts';
import { fakeRecipe, fakeRecipes } from '../helpers/fake-recipes.ts';
import { handDrivenRun, succeeded } from '../helpers/hand-driven.ts';
import { forEachSeedAsync } from '../helpers/property.ts';

const minute = 60_000;
const t0 = new Date('2026-10-26T09:00:00.000Z');
// Each step may run twice: one loss to the kill, and the attempt the limit ended, which counts not.
const recipes = fakeRecipes({ pint: fakeRecipe({ steps: ['plan', 'implement'], maxAttempts: 2 }) });
const weekly: Ending = {
  kind: 'blocked',
  blockerKind: 'environment',
  summary: 'claude hit its weekly limit, which resets 3:45pm',
  usageLimit: { limit: 'weekly', resets: '3:45pm' },
};
const opus: Ending = {
  kind: 'blocked',
  blockerKind: 'environment',
  summary: 'claude hit its Opus limit, which resets 3:45pm',
  usageLimit: { limit: 'Opus', resets: '3:45pm' },
};

/** Which limit the run hits, the family each attempt runs on, and which attempts the limit holds. */
interface Limit {
  ending: Ending;
  family?: (ref: AttemptRef) => ModelFamily | undefined;
  holds: (ref: Pick<AttemptRef, 'batchId'>) => boolean;
}
const every: Limit = { ending: weekly, holds: () => true };
// The odd batches run on Opus, the even ones on Sonnet; b1 is always there to meet the limit.
const onOpus = ({ batchId }: Pick<AttemptRef, 'batchId'>) => Number(batchId.slice(1)) % 2 === 1;
const opusOnly: Limit = {
  ending: opus,
  family: (ref) => (onOpus(ref) ? 'Opus' : 'Sonnet'),
  holds: onOpus,
};

const run = async (seed: number, { ending: limited, family, holds }: Limit): Promise<void> => {
  const random = seededRandom(seed);
  const driver = { zone: () => 'UTC', ...(family === undefined ? {} : { family }) };
  const hand = await handDrivenRun({ t0, recipes, driver });
  const { store, log, accept, tick } = hand;
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
      hand.endSome(() => random.chance(0.3));
    }
    // One running attempt hits the limit; the others still run.
    for (let each = 0; Object.keys(log.state().usageWindows).length === 0; each++) {
      assert.ok(each < 5, 'an attempt hits the limit');
      await tick();
      let ended = 0;
      hand.endSome(
        (ref) => holds(ref) && ++ended === 1,
        () => limited,
      );
    }
    const [window, ...others] = Object.values(log.state().usageWindows);
    assert.deepStrictEqual(others, [], 'one window is closed');
    assert.ok(window);
    const closedAfter = store.lastEventId();
    const notHeld = () =>
      [...log.state().batches.values()].filter(({ id }) => !holds({ batchId: id }));

    // While it is closed, what still runs ends, maybe at the limit too, and the driver is killed.
    const killAt = random.int(6);
    const reopen = Date.parse(window.reopensAt);
    for (let each = 0; hand.now().getTime() + minute < reopen; each++) {
      if (each === killAt) {
        await hand.restart();
      }
      await tick();
      hand.endSome(
        () => random.chance(0.3),
        (ref) => (holds(ref) && random.chance(0.3) ? limited : succeeded),
      );
      // Past what runs, and the batches the window does not hold, which brew on: on to just
      // before the reopen.
      const skip = reopen - 2 * minute;
      const done = notHeld().every(({ lane }) => lane.kind === 'on_tap');
      if (hand.count() === 0 && done && each > killAt && hand.now().getTime() < skip) {
        hand.skipTo(new Date(skip));
      }
    }
    const startedWhileClosed = store
      .eventsAfter(closedAfter)
      .map(({ event }) => event)
      .filter((event) => event.type === 'step.started' && holds(event));
    assert.deepStrictEqual(startedWhileClosed, [], 'no held brewer started while it was closed');
    for (const { id, lane } of notHeld()) {
      assert.equal(
        lane.kind,
        'on_tap',
        `${id}, which the window does not hold, is on tap before it reopens`,
      );
    }

    for (let each = 0; each < 40; each++) {
      await tick();
      hand.endSome(() => true);
      const lanes = [...log.state().batches.values()].map(({ lane }) => lane.kind);
      if (lanes.every((lane) => lane === 'on_tap')) break;
    }
    assert.deepStrictEqual(log.state().usageWindows, {}, 'the window reopened');
    for (const { id, lane } of log.state().batches.values()) {
      assert.equal(lane.kind, 'on_tap', `${id} is on tap after the reopen`);
    }
  } finally {
    hand.close();
  }
};

it('a driver killed while the usage window is closed starts no brewer, and every batch is on tap after the reopen', () =>
  forEachSeedAsync(30, (seed) => run(seed, every)));

it('a driver killed while the Opus window is closed starts no Opus brewer, and every batch is on tap after its reopen (ADR 0215)', () =>
  forEachSeedAsync(30, (seed) => run(seed, opusOnly)));
