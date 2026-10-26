// The limits on what the intake starts (ADR 0217) over generated states and queues: a walk never
// starts past the free capacity, a recipe's concurrency or the open-order limit, and starts every
// entry within the limits while a slot is free. The oracle counts from the generated plan, not the
// fold.

import assert from 'node:assert/strict';
import { it } from 'node:test';
import { createCommandLog } from '../../src/engine/command-log.ts';
import type { Ending } from '../../src/engine/decide.ts';
import type { TargetIssue } from '../../src/engine/issue-claims.ts';
import { chooseStarts, type Limits } from '../../src/engine/limits.ts';
import type { QueuedOrder } from '../../src/engine/ranks.ts';
import { openSqliteEventStore } from '../../src/engine/sqlite-event-store.ts';
import { type Random, seededRandom } from '../helpers/event-sequences.ts';
import { fakeRecipe, fakeRecipes } from '../helpers/fake-recipes.ts';
import { forEachSeed } from '../helpers/property.ts';

const web = 'acme/web';
const now = new Date('2026-10-26T09:00:00.000Z');
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

/** An entry of the queue, with what the oracle knows of it. */
interface Entry {
  queued: QueuedOrder;
  /** Its recipe, as its one label says; undefined for a target issue or an issue without one. */
  recipe: string | undefined;
  /** A new order, which the open-order limit holds; a sub-order is of an open order. */
  fresh: boolean;
}

const shuffled = <T>(random: Random, items: readonly T[]): T[] => {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = random.int(i + 1);
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  return out;
};

it('a walk starts within every limit, and every entry within them while a slot is free', () => {
  forEachSeed(30, (seed) => {
    const random = seededRandom(seed);
    const store = openSqliteEventStore(':memory:');
    try {
      const log = createCommandLog({ store, recipes });
      const accept = (command: Parameters<typeof log.issue>[0]): void => {
        const decision = log.issue(command, now);
        assert.equal(decision.kind, 'accepted', JSON.stringify(decision));
      };
      const listed: TargetIssue[] = [];
      const list = (number: number, labels: readonly string[]): void => {
        listed.push({
          number,
          state: 'open',
          pullRequest: false,
          labels,
          milestone: undefined,
          assignees: [],
          author: 'alice',
          created: new Date(Date.UTC(2026, 9, 26, 8, random.int(60))).toISOString(),
        });
      };
      // What holds before the walk, by the plan.
      const counted = new Map<string, number>(names.map((name) => [name, 0]));
      let open = 0;
      const entries: Entry[] = [];
      let number = 1;
      for (let o = random.int(7); o > 0; o--) {
        const issue = number++;
        const batchId = `${issue}-1`;
        const recipe = random.pick(names);
        list(issue, [`recipe:${recipe}`]);
        accept({ kind: 'order', batchId, order: { issue } });
        const lane = random.pick(['ordered', 'brewing', 'brewing', 'on_tap', 'cancelled'] as const);
        if (lane !== 'ordered' && lane !== 'cancelled') {
          accept({ kind: 'route', batchId, recipe, reason: 'label', source: 'label' });
        }
        // A breakdown: its sub-orders without a batch keep the order open, and are in the queue.
        const subOrders =
          lane !== 'cancelled' && random.chance(0.4)
            ? Array.from({ length: 1 + random.int(3) }, () => number++)
            : [];
        if (subOrders.length > 0) {
          const event = {
            type: 'order.decomposed' as const,
            batchId,
            subOrders: subOrders.map((n) => ({ issue: n, repo: web })),
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
          counted.set(recipe, (counted.get(recipe) ?? 0) + 1);
        }
        if (lane === 'ordered' || lane === 'brewing' || subOrders.length > 0) open++;
        for (const subOrder of subOrders) {
          const labelled = random.pick(names);
          list(subOrder, [`recipe:${labelled}`]);
          entries.push({
            queued: {
              order: { issue },
              created: now.toISOString(),
              source: 0,
              subOrder: { issue: subOrder, parentBatchId: batchId },
            },
            recipe: labelled,
            fresh: false,
          });
        }
      }
      for (let n = random.int(6); n > 0; n--) {
        const issue = number++;
        const labels = random.pick([
          ['recipe:a'],
          ['recipe:b'],
          ['recipe:c'],
          ['recipe:a', 'recipe:b'],
        ]);
        list(issue, labels);
        const [one, other] = labels;
        const recipe = other === undefined ? one?.slice('recipe:'.length) : undefined;
        entries.push({
          queued: { order: { issue }, created: now.toISOString(), source: 0 },
          recipe,
          fresh: true,
        });
      }
      for (let n = random.int(4); n > 0; n--) {
        const queued = {
          order: { issue: number++, repo: web },
          created: now.toISOString(),
          source: 1,
        };
        entries.push({ queued, recipe: undefined, fresh: true });
      }
      const queue = shuffled(random, entries);
      const free = random.int(7);
      const limits: Limits = { openOrders: 1 + random.int(5), recipe: (name) => concurrency[name] };

      const started = new Set(
        chooseStarts(
          log.state(),
          listed,
          queue.map(({ queued }) => queued),
          free,
          limits,
        ),
      );
      const plan = JSON.stringify({
        free,
        openOrders: limits.openOrders,
        open,
        counted: [...counted],
      });

      // Walk the queue as the oracle: what started before each entry, and whether it fit.
      const recipeCount = new Map(counted);
      let openCount = open;
      let startedCount = 0;
      for (const { queued, recipe, fresh } of queue) {
        const limit = recipe === undefined ? undefined : concurrency[recipe];
        const fits =
          startedCount < free &&
          (limit === undefined || (recipeCount.get(recipe as string) ?? 0) < limit) &&
          (!fresh || openCount < limits.openOrders);
        assert.equal(started.has(queued), fits, `${JSON.stringify(queued)} in ${plan}`);
        if (!started.has(queued)) continue;
        startedCount++;
        if (recipe !== undefined) recipeCount.set(recipe, (recipeCount.get(recipe) ?? 0) + 1);
        if (fresh) openCount++;
      }
      // Never past a limit, unless it was past it before the walk.
      assert.ok(startedCount <= free, plan);
      for (const name of names) {
        const limit = concurrency[name];
        const before = counted.get(name) ?? 0;
        const after = recipeCount.get(name) ?? 0;
        if (limit !== undefined && after > before) assert.ok(after <= limit, `${name} in ${plan}`);
      }
      if (openCount > open) assert.ok(openCount <= limits.openOrders, plan);
    } finally {
      store.close();
    }
  });
});
