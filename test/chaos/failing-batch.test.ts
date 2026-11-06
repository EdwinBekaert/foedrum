// A batch that keeps failing past the limit while others run (#883, ADR 0335): one batch per site
// throws for hours on one driver, the clock jumps and the driver is killed and started again. No
// tick rejects, a brewing batch that cannot be read does not stay brewing past the hour, one whose
// only failure is an effect never goes Stuck for it, the batch that never throws carries no mark and
// goes on, the marks stay few, the log stays one the guard accepts, an effect lands once (I4), an
// attempt holds a step's lease alone (I2), and once the throws stop every batch comes on tap with
// no mark. The run count is FOEDRUM_RUNS.

import assert from 'node:assert/strict';
import { it } from 'node:test';
import { check } from '../../src/engine/admit.ts';
import { attemptKey } from '../../src/engine/attempt-key.ts';
import type { DriverEffects } from '../../src/engine/driver.ts';
import { effectKey } from '../../src/engine/effect-key.ts';
import { emptyState, type State } from '../../src/engine/fold.ts';
import type { Recipe } from '../../src/engine/recipes.ts';
import { seededRandom } from '../helpers/event-sequences.ts';
import { fakeRecipe, fakeRecipes, hour } from '../helpers/fake-recipes.ts';
import { handDrivenRun } from '../helpers/hand-driven.ts';
import { forEachSeedAsync } from '../helpers/property.ts';

const t0 = new Date('2026-11-06T16:00:00.000Z');
const who = { by: 'ada', via: 'terminal' } as const;
const reader = 'b1';
const due = 'b2';
const refuser = 'b3';
const healthy = 'b4';

/** One comment per succeeded attempt of the batch. */
const commentsDue = (state: State, batchId: string) =>
  [...(state.batches.get(batchId)?.steps.values() ?? [])].flatMap((step) =>
    [...step.attempts.values()].flatMap((attempt) =>
      attempt.phase === 'finished' && attempt.outcome.kind === 'succeeded'
        ? [{ batchId, stepId: step.id, attempt: attempt.attempt, effect: 'comment' }]
        : [],
    ),
  );

// How many runs had the refuser's effect due at their end, so the check above was not idle.
let effectsMarked = 0;

const run = async (seed: number): Promise<void> => {
  const random = seededRandom(seed);
  let sick = true;
  // Whether a tick read the reader and it threw: another command that tick reads nothing of it.
  let threw = false;
  const base = fakeRecipe({ steps: ['plan', 'implement'], maxAttempts: 3 });
  // Deadlines far off, so what brings a batch out of brewing here is its mark.
  const pint: Recipe = { ...base, deadlineMs: () => 8 * hour };
  const reading: Recipe = {
    ...pint,
    stall: (stepId) => {
      if (sick) {
        threw = true;
        throw new Error('the recipe could not be read');
      }
      return pint.stall(stepId);
    },
  };
  const recipes = fakeRecipes({ pint, reading });
  const applied = new Map<string, number>();
  const effects: DriverEffects = {
    due: (state, batchId) => {
      if (sick && batchId === due) throw new Error('the effects could not be read');
      return commentsDue(state, batchId);
    },
    target: {
      find: async (key) => (applied.has(key) ? { result: { key } } : undefined),
      apply: async (key) => {
        if (sick && effectKey.decode(key).batchId === refuser) throw new Error('host down');
        applied.set(key, (applied.get(key) ?? 0) + 1);
        return { key };
      },
    },
  };
  const hand = await handDrivenRun({ t0, recipes, driver: { effects } });
  const { store, log, accept } = hand;
  const start = t0.getTime();
  try {
    for (const [issue, batchId] of [reader, due, refuser, healthy].entries()) {
      const recipe = batchId === reader ? 'reading' : 'pint';
      accept({ kind: 'order', batchId, order: { issue: issue + 1 } });
      accept({ kind: 'route', batchId, recipe, reason: 'label', source: 'label' });
    }

    let seen = { state: emptyState, lastId: 0 };
    const holds = (): void => {
      for (const { id, event } of store.eventsAfter(seen.lastId)) {
        const checked = check(seen.state, event);
        if (checked.kind === 'refused') assert.fail(`event ${id} breaks: ${checked.reason}`);
        seen = { state: checked.state, lastId: id };
      }
      const steps = new Set<string>();
      for (const lease of store.currentLeases(hand.now())) {
        const ref = attemptKey.decode(lease.attemptKey);
        assert.ok(ref, `lease ${lease.attemptKey} names an attempt`);
        const step = `${ref.batchId} ${ref.stepId}`;
        assert.ok(!steps.has(step), `step ${step} has two live leases`);
        steps.add(step);
      }
      for (const [key, count] of applied) assert.equal(count, 1, `effect ${key} applied ${count}`);
    };
    // The first failure since a restart, a retry or a tick that did not fail on the batch: what the
    // driver's hour counts from.
    let readFrom: number | undefined;
    const tick = async (): Promise<void> => {
      threw = false;
      await hand.tick();
      holds();
      readFrom = threw ? (readFrom ?? hand.now().getTime()) : undefined;
      const state = log.state();
      const nowMs = hand.now().getTime();
      assert.equal(state.batches.get(healthy)?.failing, undefined, 'the healthy batch is marked');
      if (sick && readFrom !== undefined && nowMs - readFrom > hour + 2 * 60_000) {
        assert.notEqual(
          state.batches.get(reader)?.lane.kind,
          'brewing',
          'an unreadable batch brews',
        );
      }
      const refuserLane = state.batches.get(refuser)?.lane;
      if (refuserLane?.kind === 'stuck') {
        assert.notEqual(refuserLane.reason.kind, 'failing', 'an effect made a batch Stuck');
      }
      const events = store.eventsAfter(0).map(({ event }) => event);
      const hours = Math.ceil((nowMs - start) / hour);
      for (const batchId of [reader, due, refuser]) {
        const marks = events.filter((e) => e.type === 'batch.failing' && e.batchId === batchId);
        assert.ok(
          marks.length <= hours + 1,
          `${batchId} has ${marks.length} marks in ${hours} hours`,
        );
      }
    };

    // The refuser past its first step, so its effect fails from the start.
    await tick();
    hand.endSome(({ batchId }) => batchId === refuser);
    const rounds = 80 + random.int(40);
    for (let each = rounds; each > 0; each--) {
      if (random.chance(0.04)) {
        hand.skipTo(new Date(hand.now().getTime() + hour + 60_000));
        // A jump is an hour the driver did not read in: the next tick's failure measures it.
      }
      if (random.chance(0.03)) {
        await hand.restart();
        readFrom = undefined;
      }
      hand.endSome(({ batchId }) => batchId !== reader && random.chance(0.05));
      await tick();
      // A person retries now and then: a new hour for it.
      const lane = log.state().batches.get(reader)?.lane;
      if (lane?.kind === 'stuck' && lane.reason.kind === 'failing' && random.chance(0.1)) {
        log.issue({ kind: 'retry', batchId: reader, ...who }, hand.now());
        readFrom = undefined;
      }
    }

    // An hour past the last restart, the refuser's failing effect has marked it. A schedule may lose
    // its attempts to kills and clock jumps until it is Stuck on them with none succeeded: then no
    // effect of it was ever due, and nothing failed to mark.
    await tick();
    const effectDue = commentsDue(log.state(), refuser).length > 0;
    hand.skipTo(new Date(hand.now().getTime() + hour + 60_000));
    await tick();
    if (effectDue) {
      assert.notEqual(log.state().batches.get(refuser)?.failing, undefined, 'the effect marked it');
    }
    if (effectDue) effectsMarked++;
    // The throws stop: a person's retries bring every batch on tap, and the marks go.
    sick = false;
    for (let each = 0; each < 80; each++) {
      await tick();
      hand.endSome(() => true);
      const batches = [...log.state().batches.values()];
      if (batches.every(({ lane, failing }) => lane.kind === 'on_tap' && failing === undefined)) {
        break;
      }
      for (const batch of batches) {
        if (batch.lane.kind === 'stuck') {
          log.issue({ kind: 'retry', batchId: batch.id, ...who }, hand.now());
        }
      }
    }
    for (const batch of log.state().batches.values()) {
      assert.equal(batch.lane.kind, 'on_tap', `${batch.id} is on tap once it reads`);
      assert.equal(batch.failing, undefined, `${batch.id} still carries its mark`);
    }
  } finally {
    hand.close();
  }
};

it('batches that fail past the limit stop none of the others, and come to rest once they read', async () => {
  effectsMarked = 0;
  await forEachSeedAsync(10, run);
  // None when one seed is replayed and it has no effect due, so only over several.
  if (process.env.FOEDRUM_SEED === undefined) {
    assert.ok(effectsMarked > 0, 'a run had an effect that failed and marked its batch');
  }
});
