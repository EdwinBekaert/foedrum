// The ready set (ADR 0211) over generated breakdowns: one intake pass never orders a sub-order whose
// blocker has not merged, never more than the free capacity, and every ready sub-order while a slot
// is free. The oracle below reads the generated plan, not the fold.

import assert from 'node:assert/strict';
import { it } from 'node:test';
import { createCommandLog } from '../../src/engine/command-log.ts';
import { createIntake, type TargetTracker } from '../../src/engine/intake.ts';
import type { TargetIssue } from '../../src/engine/issue-claims.ts';
import { openSqliteEventStore } from '../../src/engine/sqlite-event-store.ts';
import type { Dependency, Event } from '../../src/schemas/events.ts';
import { seededRandom } from '../helpers/event-sequences.ts';
import { fakeGitHub } from '../helpers/fake-github.ts';
import { fakeRecipe, fakeRecipes } from '../helpers/fake-recipes.ts';
import { forEachSeedAsync } from '../helpers/property.ts';

const brewery = 'alice/brewery';
const now = new Date('2026-10-26T12:00:00.000Z');
const routeBy = '2026-10-26T13:00:00.000Z';
const recipes = fakeRecipes({ half: fakeRecipe({ steps: ['plan'] }) });

/** How a sub-order stands before the pass: no batch, or a batch and its pull request. */
type Standing = 'none' | 'brewing' | 'open' | 'closed' | 'merged';

interface Plan {
  events: Event[];
  listed: TargetIssue[];
  capacity: number;
  /** Every sub-order, with its order and how it stands. */
  subOrders: Map<number, { order: number; standing: Standing }>;
  dependencies: Dependency[];
  /** The batches Ordered or Brewing before the pass. */
  busy: number;
}

const generate = (seed: number): Plan => {
  const random = seededRandom(seed);
  const events: Event[] = [];
  const listed: TargetIssue[] = [];
  const subOrders = new Map<number, { order: number; standing: Standing }>();
  const dependencies: Dependency[] = [];
  let busy = 0;
  let number = 1;
  const issue = (n: number): TargetIssue => ({
    number: n,
    state: 'open',
    pullRequest: false,
    labels: ['recipe:half'],
    milestone: undefined,
    assignees: [],
    author: 'alice',
    created: new Date(Date.UTC(2026, 9, 26, 10, random.int(5))).toISOString(),
  });
  for (let o = 1 + random.int(3); o > 0; o--) {
    const order = number++;
    const batchId = `${order}-1`;
    listed.push(issue(order));
    events.push({ type: 'batch.ordered', batchId, order: { issue: order }, routeBy });
    const plan = Array.from({ length: 1 + random.int(5) }, () => number++);
    const blocks: Dependency[] = [];
    plan.forEach((subOrder, i) => {
      // Blocked only by an earlier sub-order of the plan: no cycle.
      for (let j = 0; j < i; j++) {
        if (random.chance(0.3)) {
          blocks.push({
            subOrder,
            blockedBy: plan[j] as number,
            kind: random.pick(['code', 'code', 'release']),
          });
        }
      }
    });
    events.push({
      type: 'order.decomposed',
      batchId,
      subOrders: plan.map((n) => ({ issue: n, repo: 'acme/web' })),
      dependencies: blocks,
    });
    events.push({ type: 'batch.on_tap', batchId, pullRequests: [] });
    dependencies.push(...blocks);
    for (const subOrder of plan) {
      listed.push(issue(subOrder));
      const standing: Standing = random.pick([
        'none',
        'none',
        'brewing',
        'open',
        'closed',
        'merged',
      ]);
      subOrders.set(subOrder, { order, standing });
      if (standing === 'none') continue;
      const id = `${subOrder}-1`;
      const url = `https://github.com/acme/web/pull/${subOrder}`;
      events.push({
        type: 'batch.ordered',
        batchId: id,
        order: { issue: subOrder },
        parentBatchId: batchId,
        routeBy,
      });
      if (standing === 'brewing') {
        busy++;
        continue;
      }
      events.push({ type: 'batch.on_tap', batchId: id, pullRequests: [url] });
      if (standing !== 'open') {
        events.push({ type: 'pull_request.ended', batchId: id, pullRequest: url, state: standing });
      }
    }
  }
  return { events, listed, capacity: random.int(8), subOrders, dependencies, busy };
};

/** Whether `subOrder` may start, by the generated plan alone. */
const isReady = (plan: Plan, subOrder: number): boolean =>
  plan.subOrders.get(subOrder)?.standing === 'none' &&
  plan.dependencies
    .filter((dependency) => dependency.subOrder === subOrder)
    .every(
      ({ blockedBy, kind }) =>
        kind === 'code' && plan.subOrders.get(blockedBy)?.standing === 'merged',
    );

it('one pass orders only ready sub-orders, within the free capacity, and all of them while slots are free', () =>
  forEachSeedAsync(100, async (seed) => {
    const plan = generate(seed);
    const store = openSqliteEventStore(':memory:');
    try {
      store.withTransaction((tx) => {
        for (const event of plan.events) tx.append(event);
      });
      const log = createCommandLog({ store, recipes });
      const before = new Set(log.state().batches.keys());
      const tracker: TargetTracker = {
        issues: async (repo) => (repo === brewery ? plan.listed : []),
        pullRequest: async () => 'open',
      };
      await createIntake({
        log,
        brewery,
        tracker,
        claims: fakeGitHub().host,
        claimant: { brewery, login: 'alice' },
        authors: ['alice'],
        repositories: [],
        capacity: plan.capacity,
        clock: () => now,
      }).poll();
      const started = [...log.state().batches.values()]
        .filter(({ id }) => !before.has(id))
        .map(({ issue }) => issue);
      const free = Math.max(0, plan.capacity - plan.busy);
      for (const subOrder of started) {
        assert.ok(isReady(plan, subOrder), `#${subOrder} was not ready`);
      }
      assert.ok(started.length <= free, `${started.length} started, ${free} free`);
      const ready = [...plan.subOrders.keys()].filter((subOrder) => isReady(plan, subOrder));
      if (started.length < free) {
        assert.deepStrictEqual([...started].sort(), [...ready].sort());
      } else {
        assert.equal(started.length, Math.min(free, ready.length));
      }
    } finally {
      store.close();
    }
  }));
