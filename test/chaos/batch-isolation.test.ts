// One batch's error stops no other's work (#870, ADR 0328): batches brew on one driver while some
// throw at its sites for a while (the deadline's reading, the drive, an attempt's start, the effects'
// reading), the clock jumps past deadlines, and the driver is killed and started again. No tick
// rejects, a batch that reads meets its deadlines (I5, I1), one attempt holds a step's lease (I2), the
// log stays one the guard accepts, an effect lands once (I4), each failure is said once per pass, and
// once the throws stop a person's retries bring every batch on tap. The run count is FOEDRUM_RUNS.

import assert from 'node:assert/strict';
import { it } from 'node:test';
import { check } from '../../src/engine/admit.ts';
import { type AttemptRef, attemptKey } from '../../src/engine/attempt-key.ts';
import type { DriverEffects, DriverNotice } from '../../src/engine/driver.ts';
import { effectKey } from '../../src/engine/effect-key.ts';
import { emptyState, type State } from '../../src/engine/fold.ts';
import type { Recipe } from '../../src/engine/recipes.ts';
import { defaultLimits } from '../helpers/brewing.ts';
import { seededRandom } from '../helpers/event-sequences.ts';
import { fakeRecipe, fakeRecipes, hour } from '../helpers/fake-recipes.ts';
import { handDrivenRun } from '../helpers/hand-driven.ts';
import { forEachSeedAsync } from '../helpers/property.ts';
import { running } from '../helpers/simulation.ts';

const t0 = new Date('2026-11-06T16:00:00.000Z');
const who = { by: 'ada', via: 'terminal' } as const;
const sites = ['recipe', 'family', 'limits', 'effects'] as const;
type Site = (typeof sites)[number];
const boom = (site: Site): Error => new Error(`${site} threw`);

/** One comment per succeeded attempt of the batch. */
const commentsDue = (state: State, batchId: string) =>
  [...(state.batches.get(batchId)?.steps.values() ?? [])].flatMap((step) =>
    [...step.attempts.values()].flatMap((attempt) =>
      attempt.phase === 'finished' && attempt.outcome.kind === 'succeeded'
        ? [{ batchId, stepId: step.id, attempt: attempt.attempt, effect: 'comment' }]
        : [],
    ),
  );

const fired = new Set<Site>();

const run = async (seed: number): Promise<void> => {
  const random = seededRandom(seed);
  // Each site throws for one batch, and the batch after them never throws.
  const order = [...sites].sort(() => random.int(3) - 1);
  const siteOf = new Map(order.map((site, index) => [`b${index + 1}`, site]));
  const healthy = `b${sites.length + 1}`;
  const sick = new Set(siteOf.keys());
  const throwAt = (batchId: string, site: Site): void => {
    if (sick.has(batchId) && siteOf.get(batchId) === site) {
      fired.add(site);
      throw boom(site);
    }
  };
  const pint = fakeRecipe({ steps: ['plan', 'implement'], maxAttempts: 3 });
  const reading: Recipe = {
    ...pint,
    interactive: (stepId) => {
      // The batch is the only one on this recipe.
      throwAt(`b${order.indexOf('recipe') + 1}`, 'recipe');
      return pint.interactive(stepId);
    },
  };
  const recipes = fakeRecipes({ pint, reading });
  const applied = new Map<string, number>();
  const effects: DriverEffects = {
    due: (state, batchId) => {
      throwAt(batchId, 'effects');
      return commentsDue(state, batchId);
    },
    target: {
      find: async (key) => (applied.has(key) ? { result: { key } } : undefined),
      apply: async (key) => {
        applied.set(key, (applied.get(key) ?? 0) + 1);
        return { key };
      },
    },
  };
  let notices: DriverNotice[] = [];
  const lastSaid = new Map<string, string>();
  const saidTwice: string[] = [];
  const hand = await handDrivenRun({
    t0,
    recipes,
    driver: {
      family: ({ batchId }: AttemptRef) => {
        throwAt(batchId, 'family');
        return undefined;
      },
      limits: ({ batchId }: AttemptRef) => {
        throwAt(batchId, 'limits');
        return defaultLimits;
      },
      effects,
      report: (notice) => {
        notices.push(notice);
        // Said once until its message changes or it recovers (ADR 0328).
        if (notice.kind === 'batch_recovered') {
          lastSaid.delete(`${notice.batchId} ${notice.pass}`);
          return;
        }
        if (notice.kind !== 'batch_failed' && notice.kind !== 'batch_effects_failed') return;
        const pass = notice.kind === 'batch_failed' ? notice.pass : 'effects';
        const key = `${notice.batchId} ${pass}`;
        const message = String(notice.error);
        // Asserted after the tick: the driver ignores a report that throws.
        if (lastSaid.get(key) === message) saidTwice.push(`${key}: ${message}`);
        lastSaid.set(key, message);
      },
    },
  });
  const { store, log, accept } = hand;
  try {
    for (let issue = 1; issue <= sites.length + 1; issue++) {
      const batchId = `b${issue}`;
      const recipe = siteOf.get(batchId) === 'recipe' ? 'reading' : 'pint';
      accept({ kind: 'order', batchId, order: { issue } });
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
    /** A tick, after which every batch that reads has its next deadline ahead. */
    const tick = async (): Promise<void> => {
      notices = [];
      await hand.tick();
      holds();
      assert.deepStrictEqual(saidTwice, [], 'a failure said again with nothing changed');
      const now = hand.now().getTime();
      const named = notices.flatMap((notice) =>
        notice.kind === 'batch_failed' || notice.kind === 'batch_effects_failed'
          ? [`${notice.batchId} ${notice.kind === 'batch_failed' ? notice.pass : 'effects'}`]
          : [],
      );
      assert.equal(new Set(named).size, named.length, `said twice in a tick: ${named.join(', ')}`);
      assert.ok(!named.some((each) => each.startsWith(`${healthy} `)), 'the healthy batch failed');
      for (const batch of log.state().batches.values()) {
        const { lane } = batch;
        if (sick.has(batch.id) && siteOf.get(batch.id) === 'recipe') continue;
        if (lane.kind === 'brewing') {
          for (const attempt of running(batch)) {
            assert.ok(Date.parse(attempt.deadlineAt) > now, `${batch.id} is past its deadline`);
          }
        }
        if (lane.kind === 'stuck') {
          assert.ok(Date.parse(lane.remindAt) > now, `${batch.id} is past its reminder`);
        }
      }
    };

    const rounds = 12 + random.int(12);
    for (let each = rounds; each > 0; each--) {
      if (random.chance(0.15)) {
        hand.skipTo(new Date(hand.now().getTime() + hour + 60_000));
      }
      // Each stays sick for the first tick, so each site throws in every run, a replayed one too.
      if (each < rounds) {
        for (const batchId of [...sick]) if (random.chance(0.08)) sick.delete(batchId);
      }
      if (random.chance(0.1)) {
        await hand.restart();
        // What it said is in the driver's memory, which went with it.
        lastSaid.clear();
      }
      hand.endSome(() => random.chance(0.4));
      await tick();
    }

    // The throws stop: a person's retries bring every batch on tap, the healthy one with them.
    sick.clear();
    for (let each = 0; each < 80; each++) {
      await tick();
      hand.endSome(() => true);
      const lanes = [...log.state().batches.values()];
      if (lanes.every(({ lane }) => lane.kind === 'on_tap')) break;
      for (const batch of lanes) {
        if (batch.lane.kind === 'stuck') {
          log.issue({ kind: 'retry', batchId: batch.id, ...who }, hand.now());
        }
      }
    }
    for (const batch of log.state().batches.values()) {
      assert.equal(batch.lane.kind, 'on_tap', `${batch.id} is on tap once it reads`);
    }
    for (const batchId of log.state().batches.keys()) {
      const due = commentsDue(log.state(), batchId);
      assert.ok(due.length > 0, `${batchId} has an effect due`);
      for (const key of due) {
        const text = effectKey.encode(key);
        assert.equal(applied.get(text), 1, `${text} reached the host once`);
      }
    }
  } finally {
    hand.close();
  }
};

it('batches that throw at the driver’s sites stop none of the others, and come to rest once they read', async () => {
  fired.clear();
  await forEachSeedAsync(30, run);
  assert.deepStrictEqual([...fired].sort(), [...sites].sort(), 'every site threw in some run');
});
