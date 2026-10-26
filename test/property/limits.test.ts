// The limits on what the intake starts (ADR 0217) over generated states and listings, through the
// intake's own pass: it never orders past the free capacity, a recipe's concurrency or the
// open-order limit, its routing never brews a recipe past its concurrency, and it orders every
// entry of its queue within the limits while a slot is free. The oracle counts from the generated
// plan, not the fold.

import assert from 'node:assert/strict';
import { it } from 'node:test';
import { createCommandLog } from '../../src/engine/command-log.ts';
import type { Ending } from '../../src/engine/decide.ts';
import { createIntake, intakeQueue, type TargetTracker } from '../../src/engine/intake.ts';
import type { Claimant, TargetIssue } from '../../src/engine/issue-claims.ts';
import type { Limits } from '../../src/engine/limits.ts';
import { openSqliteEventStore } from '../../src/engine/sqlite-event-store.ts';
import { seededRandom } from '../helpers/event-sequences.ts';
import { fakeGitHub } from '../helpers/fake-github.ts';
import { fakeRecipe, fakeRecipes } from '../helpers/fake-recipes.ts';
import { forEachSeedAsync } from '../helpers/property.ts';

const brewery = 'alice/brewery';
const web = 'acme/web';
const now = new Date('2026-10-26T09:00:00.000Z');
const claimant: Claimant = { brewery, login: 'alice' };
const repository = { repo: web, alias: 'web', filter: { labels: ['foedrum'] } };
/** Each recipe's concurrency: `c` has none. */
const concurrency: Readonly<Record<string, number | undefined>> = { a: 1, b: 2, c: undefined };
const names = Object.keys(concurrency);
const recipes = fakeRecipes(
  Object.fromEntries(
    names.map((name) => {
      const limit = concurrency[name];
      const own = limit === undefined ? {} : { concurrency: limit };
      return [name, { ...fakeRecipe({ steps: ['plan'] }), ...own }];
    }),
  ),
);
const succeeded: Ending = {
  kind: 'succeeded',
  output: { status: 'done', summary: 'Done', assumptions: [] },
};

it('a pass orders and routes within every limit, and every entry within them while a slot is free', async () => {
  await forEachSeedAsync(30, async (seed) => {
    const random = seededRandom(seed);
    const store = openSqliteEventStore(':memory:');
    try {
      const log = createCommandLog({ store, recipes });
      const accept = (command: Parameters<typeof log.issue>[0]): void => {
        const decision = log.issue(command, now);
        assert.equal(decision.kind, 'accepted', JSON.stringify(decision));
      };
      const issue = (number: number, labels: readonly string[]): TargetIssue => ({
        number,
        state: 'open',
        pullRequest: false,
        labels,
        milestone: undefined,
        assignees: [],
        author: 'alice',
        created: new Date(Date.UTC(2026, 9, 26, 8, random.int(60))).toISOString(),
      });
      const listed: TargetIssue[] = [];
      const targets: TargetIssue[] = [];
      // What the plan knows: each issue's one recipe, the sub-orders, and what holds before.
      const recipeOf = new Map<number, string>();
      const subOrders = new Set<number>();
      const brewing = new Map<string, number>(names.map((name) => [name, 0]));
      const counted = new Map<string, number>(names.map((name) => [name, 0]));
      let open = 0;
      let busy = 0;
      let number = 1;
      for (let o = random.int(7); o > 0; o--) {
        const order = number++;
        const batchId = `${order}-1`;
        const recipe = random.pick(names);
        listed.push(issue(order, [`recipe:${recipe}`]));
        accept({ kind: 'order', batchId, order: { issue: order } });
        const lane = random.pick(['ordered', 'brewing', 'brewing', 'on_tap', 'cancelled'] as const);
        if (lane !== 'ordered' && lane !== 'cancelled') {
          accept({ kind: 'route', batchId, recipe, reason: 'label', source: 'label' });
        }
        // A breakdown: its sub-orders without a batch keep the order open, and are in the queue.
        const plan =
          lane !== 'cancelled' && random.chance(0.4)
            ? Array.from({ length: 1 + random.int(3) }, () => number++)
            : [];
        if (plan.length > 0) {
          const event = {
            type: 'order.decomposed' as const,
            batchId,
            subOrders: plan.map((n) => ({ issue: n, repo: web })),
            dependencies: [],
          };
          accept({ kind: 'record', event });
        }
        if (lane === 'on_tap') {
          const event = { type: 'step.started', batchId, stepId: 'plan', attempt: 1 } as const;
          accept({ kind: 'record', event });
          accept({ kind: 'finish', batchId, stepId: 'plan', attempt: 1, ending: succeeded });
        }
        if (lane === 'cancelled') accept({ kind: 'cancel', batchId, by: 'alice', via: 'terminal' });
        if (lane === 'ordered' || lane === 'brewing') {
          busy++;
          counted.set(recipe, (counted.get(recipe) ?? 0) + 1);
        }
        if (lane === 'brewing') brewing.set(recipe, (brewing.get(recipe) ?? 0) + 1);
        if (lane === 'ordered' || lane === 'brewing' || plan.length > 0) open++;
        for (const subOrder of plan) {
          const labelled = random.pick(names);
          listed.push(issue(subOrder, [`recipe:${labelled}`]));
          recipeOf.set(subOrder, labelled);
          subOrders.add(subOrder);
        }
      }
      for (let n = random.int(6); n > 0; n--) {
        const order = number++;
        const labels = random.pick([
          ['recipe:a'],
          ['recipe:b'],
          ['recipe:c'],
          ['recipe:a', 'recipe:b'],
        ]);
        listed.push(issue(order, labels));
        const [one, other] = labels;
        if (one !== undefined && other === undefined)
          recipeOf.set(order, one.slice('recipe:'.length));
      }
      for (let n = random.int(4); n > 0; n--) targets.push(issue(number++, ['foedrum']));
      const free = random.int(7);
      const limits: Limits = { openOrders: 1 + random.int(5), recipe: (name) => concurrency[name] };

      // The queue the pass walks, in its rank order.
      const before = log.state();
      const queue = intakeQueue(
        before,
        { brewery: listed, repositories: [{ repository, issues: targets }] },
        { authors: ['alice'], claimant },
      );
      const tracker: TargetTracker = {
        issues: async (repo) => (repo === brewery ? listed : targets),
        pullRequest: async () => 'open',
      };
      const github = fakeGitHub();
      const intake = createIntake({
        log,
        brewery,
        tracker,
        claims: github.host,
        claimant,
        authors: ['alice'],
        repositories: [repository],
        capacity: busy + free,
        limits,
        clock: () => now,
      });
      await intake.poll();
      const after = log.state();
      const ordered = new Set([...after.batches.keys()].filter((id) => !before.batches.has(id)));
      const plan = JSON.stringify({
        seed,
        free,
        openOrders: limits.openOrders,
        open,
        counted: [...counted],
      });

      // Walk the queue as the oracle: what was ordered before each entry, and whether it fit.
      const recipeCount = new Map(counted);
      let openCount = open;
      let startedCount = 0;
      for (const { order, subOrder } of queue) {
        const own = subOrder?.issue ?? order.issue;
        const batchId = order.repo === undefined ? `${own}-1` : `web-${order.issue}`;
        const recipe = order.repo === undefined ? recipeOf.get(own) : undefined;
        const fresh = !subOrders.has(own);
        const limit = recipe === undefined ? undefined : concurrency[recipe];
        const fits =
          startedCount < free &&
          (limit === undefined || (recipeCount.get(recipe as string) ?? 0) < limit) &&
          (!fresh || openCount < limits.openOrders);
        assert.equal(ordered.has(batchId), fits, `${batchId} in ${plan}`);
        if (!fits) continue;
        startedCount++;
        if (recipe !== undefined) recipeCount.set(recipe, (recipeCount.get(recipe) ?? 0) + 1);
        if (fresh) openCount++;
      }
      // Never past a limit, unless it was past it before the pass.
      assert.equal(ordered.size, startedCount, plan);
      assert.ok(startedCount <= free, plan);
      if (openCount > open) assert.ok(openCount <= limits.openOrders, plan);
      for (const name of names) {
        const limit = concurrency[name];
        if (limit === undefined) continue;
        const ofRecipe = (counts: Map<string, number>) => counts.get(name) ?? 0;
        if (ofRecipe(recipeCount) > ofRecipe(counted))
          assert.ok(ofRecipe(recipeCount) <= limit, `${name} in ${plan}`);
        // The routing: brewing after the pass is within the limit, or no more than before.
        const brewed = [...after.batches.values()].filter(
          (batch) => batch.lane.kind === 'brewing' && batch.recipe?.name === name,
        ).length;
        assert.ok(
          brewed <= Math.max(limit, ofRecipe(brewing)),
          `${name} brews ${brewed} in ${plan}`,
        );
      }
    } finally {
      store.close();
    }
  });
});
