// A sub-order the approved plan marks `"testFirst": false` (ADR 0371): its batch skips its recipe's
// test-first steps, with the plan's reason; one without the field, and an order that is no
// sub-order, run their recipe's own. Nip's steps come from Foedrum's defaults. Nothing reaches a
// model or GitHub (ADR 0021).

import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { FOEDRUM_DEFAULTS, readBreweryFiles } from '../../src/engine/brewery-files.ts';
import { type Context, decide } from '../../src/engine/decide.ts';
import { fold } from '../../src/engine/fold.ts';
import { loadRecipes } from '../../src/engine/recipe-files.ts';
import type { Event } from '../../src/schemas/events.ts';
import { PlanOutDoc } from '../../src/schemas/plan.ts';

const at = '2026-11-10T10:00:00.000Z';
const reason = 'it only rewords the help text';

const subOrder = (id: string, more: Record<string, unknown> = {}): Record<string, unknown> => ({
  id,
  title: `Build ${id}`,
  repo: 'acme/api',
  size: { lines: 40, mechanism: 'one help text' },
  doneWhen: 'the help text reads as the order asks',
  touches: [{ path: 'src/help.ts' }],
  dependencies: [],
  recipe: 'nip',
  why: 'a small change in one repository',
  ready: true,
  ...more,
});

const done = (...subOrders: unknown[]) => ({
  status: 'done',
  summary: 'Planned',
  assumptions: [],
  subOrders,
});

/** Batch 7-1 planned the order with `plan`, and a person approved it. */
const planned = (plan: unknown): Event[] => [
  { type: 'batch.ordered', batchId: '7-1', order: { issue: 7 }, routeBy: at },
  { type: 'step.scheduled', batchId: '7-1', stepId: 'plan', attempt: 1, deadlineAt: at },
  { type: 'step.started', batchId: '7-1', stepId: 'plan', attempt: 1 },
  {
    type: 'step.finished',
    batchId: '7-1',
    stepId: 'plan',
    attempt: 1,
    outcome: { kind: 'succeeded', output: JSON.parse(JSON.stringify(plan)) },
  },
  {
    type: 'batch.approved',
    batchId: '7-1',
    stepId: 'plan',
    attempt: 1,
    plan: '0123456789abcdef',
    by: 'ann',
    via: 'terminal',
    at,
  },
];

/** Batch 12-1, ordered from the plan's entry `entry`, or as an order of its own without one. */
const ordered = (entry?: string): Event => ({
  type: 'batch.ordered',
  batchId: '12-1',
  order: { issue: 12 },
  routeBy: at,
  ...(entry === undefined
    ? {}
    : { parentBatchId: '7-1', plan: { batchId: '7-1', stepId: 'plan', attempt: 1, entry } }),
});

const context = (): Context => {
  const loaded = loadRecipes(readBreweryFiles(join(FOEDRUM_DEFAULTS, 'no-such-brewery')));
  assert.ok(loaded.valid, loaded.valid ? '' : loaded.problems.join('\n'));
  return {
    now: new Date(at),
    reminderMs: 86_400_000,
    routingMs: 3_600_000,
    recipes: loaded.recipes,
  };
};

/** What routing batch 12-1 to Nip records after `events`: each event's type and step. */
const routed = (events: Event[]) => {
  const decision = decide(
    fold(events),
    { kind: 'route', batchId: '12-1', recipe: 'nip', reason: 'label', source: 'label' },
    context(),
  );
  assert.equal(decision.kind, 'accepted', JSON.stringify(decision));
  const recorded = decision.kind === 'accepted' ? decision.events : [];
  return {
    recorded,
    steps: recorded.flatMap((event) =>
      'stepId' in event ? [`${event.type} ${event.stepId}`] : [],
    ),
  };
};

describe("a plan entry's testFirst false is what its sub-order's batch does (ADR 0371)", () => {
  it("a sub-order without the field runs its recipe's test-first: regression test", () => {
    const { steps } = routed([...planned(done(subOrder('help'))), ordered('help')]);
    assert.deepStrictEqual(steps, ['step.scheduled survey']);
  });

  it("an order that is no sub-order runs its recipe's test-first, unchanged: regression test", () => {
    // The plan of another order says test-first off, but batch 12-1 was not ordered from it.
    const plan = done(subOrder('help', { testFirst: false, testFirstOff: reason }));
    const { steps } = routed([...planned(plan), ordered()]);
    assert.deepStrictEqual(steps, ['step.scheduled survey']);
  });

  it('a security-marked sub-order still refuses testFirst false: regression test', () => {
    const read = PlanOutDoc.safeParse(
      done(
        subOrder('help', {
          testFirst: false,
          testFirstOff: reason,
          securityMark: "the issue's title reaches the help text",
        }),
      ),
    );
    assert.equal(read.success, false);
    assert.match(
      JSON.stringify(read.error?.issues),
      /A sub-order with a securityMark keeps test-first on/,
    );
  });
});
