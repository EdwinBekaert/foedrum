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
import { planEntryText, renderPlan } from '../../src/engine/plan-comment.ts';
import { loadRecipes } from '../../src/engine/recipe-files.ts';
import { renderStatus } from '../../src/engine/status-comment.ts';
import type { Event } from '../../src/schemas/events.ts';
import { PlanOutDoc, planOf } from '../../src/schemas/plan.ts';

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

/**
 * Batch 12-1, ordered from the plan's entry `entry` of plan attempt `attempt`, or as an order of
 * its own without one.
 */
const ordered = (entry?: string, attempt = 1): Event => ({
  type: 'batch.ordered',
  batchId: '12-1',
  order: { issue: 12 },
  routeBy: at,
  ...(entry === undefined
    ? {}
    : { parentBatchId: '7-1', plan: { batchId: '7-1', stepId: 'plan', attempt, entry } }),
});

/** Attempt 2 of batch 7-1's plan step, scheduled, and when `plan` is given, done with it. */
const plannedAgain = (plan?: unknown): Event[] => [
  { type: 'step.scheduled', batchId: '7-1', stepId: 'plan', attempt: 2, deadlineAt: at },
  ...(plan === undefined
    ? []
    : [
        { type: 'step.started', batchId: '7-1', stepId: 'plan', attempt: 2 } as const,
        {
          type: 'step.finished',
          batchId: '7-1',
          stepId: 'plan',
          attempt: 2,
          outcome: { kind: 'succeeded', output: JSON.parse(JSON.stringify(plan)) },
        } as const,
      ]),
];

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

// The test-first steps routing reaches: the Gauger's and the red proof's skips come after the
// Maltster's map, which runs with test-first off too (ADR 0395).
const testFirstSteps = ['survey', 'survey-check'];

describe("a plan entry's testFirst false is what its sub-order's batch does (ADR 0371)", () => {
  it('a sub-order approved with testFirst false skips the test-first steps before its map and says why', () => {
    const plan = done(subOrder('help', { testFirst: false, testFirstOff: reason }));
    const events = [...planned(plan), ordered('help')];
    const { recorded, steps } = routed(events);
    assert.deepStrictEqual(steps, [
      ...testFirstSteps.map((stepId) => `step.skipped ${stepId}`),
      'step.scheduled map',
    ]);
    const batch = fold([...events, ...recorded]).batches.get('12-1');
    assert.ok(batch);
    const text = renderStatus(batch);
    for (const stepId of testFirstSteps) {
      const line = text.split('\n').find((each) => each.includes(`\`${stepId}\``)) ?? '';
      assert.match(
        line,
        /skipped: test-first is off in the approved plan: it only rewords the help text$/,
      );
    }
  });

  it('a sub-order approved with testFirst false skips the Gauger and the red proof once its map ends, and says why', () => {
    const plan = done(subOrder('help', { testFirst: false, testFirstOff: reason }));
    const ordering = [...planned(plan), ordered('help')];
    const map = { batchId: '12-1', stepId: 'map', attempt: 1 };
    const route = routed(ordering);
    assert.equal(route.steps.at(-1), 'step.scheduled map');
    const events: Event[] = [...ordering, ...route.recorded, { type: 'step.started', ...map }];
    const decision = decide(
      fold(events),
      {
        kind: 'finish',
        ...map,
        ending: { kind: 'succeeded', output: { status: 'done', summary: 'Mapped' } },
      },
      context(),
    );
    assert.equal(decision.kind, 'accepted', JSON.stringify(decision));
    const recorded = decision.kind === 'accepted' ? decision.events : [];
    assert.deepStrictEqual(
      recorded.flatMap((event) => ('stepId' in event ? [`${event.type} ${event.stepId}`] : [])),
      ['step.finished map', 'step.skipped gauge', 'step.skipped red', 'step.scheduled implement'],
    );
    const text = renderStatus(fold([...events, ...recorded]).batches.get('12-1') ?? assert.fail());
    for (const stepId of ['gauge', 'red']) {
      const line = text.split('\n').find((each) => each.includes(`\`${stepId}\``)) ?? '';
      assert.match(
        line,
        /skipped: test-first is off in the approved plan: it only rewords the help text$/,
        stepId,
      );
    }
  });

  it("a sub-order without the field runs its recipe's test-first: regression test", () => {
    const { steps } = routed([...planned(done(subOrder('help'))), ordered('help')]);
    assert.deepStrictEqual(steps, ['step.scheduled survey']);
  });

  it('reads the entry its batch was ordered from, in a plan that mixes test-first on and off: regression test', () => {
    const off = subOrder('help', { testFirst: false, testFirstOff: reason });
    const skips = [
      ...testFirstSteps.map((stepId) => `step.skipped ${stepId}`),
      'step.scheduled map',
    ];
    // The entry turned off first, then second, so neither the first entry nor the first off one
    // stands in for the one the batch names.
    for (const plan of [done(off, subOrder('other')), done(subOrder('other'), off)]) {
      assert.deepStrictEqual(routed([...planned(plan), ordered('other')]).steps, [
        'step.scheduled survey',
      ]);
      assert.deepStrictEqual(routed([...planned(plan), ordered('help')]).steps, skips);
    }
  });

  it('reads the entry from the plan attempt its batch was ordered from, once it succeeded: regression test', () => {
    const on = done(subOrder('help'));
    const off = done(subOrder('help', { testFirst: false, testFirstOff: reason }));
    const steps = (events: Event[]) => routed(events).steps[0];
    assert.equal(
      steps([...planned(on), ...plannedAgain(off), ordered('help', 2)]),
      'step.skipped survey',
    );
    assert.equal(
      steps([...planned(off), ...plannedAgain(on), ordered('help', 2)]),
      'step.scheduled survey',
    );
    // Attempt 2 has not ended: it wrote no plan to read, whatever attempt 1 said.
    assert.equal(
      steps([...planned(off), ...plannedAgain(), ordered('help', 2)]),
      'step.scheduled survey',
    );
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

  it('the plan comment and the plan entry say its batch skips the test-first steps', () => {
    const plan = done(subOrder('help', { testFirst: false, testFirstOff: reason }));
    const line =
      "- Recipe `nip`: a small change in one repository; test-first off, so its batch skips its recipe's test-first steps: it only rewords the help text";
    const report = planOf(plan);
    assert.ok(report);
    const rendered = renderPlan('7-1', 'plan', report);
    assert.ok(rendered.split('\n').includes(line), rendered);
    const origin = { batchId: '7-1', stepId: 'plan', attempt: 1, entry: 'help' };
    const entry = planEntryText(fold(planned(plan)), origin);
    assert.ok(entry.split('\n').includes(line), entry);
  });
});
