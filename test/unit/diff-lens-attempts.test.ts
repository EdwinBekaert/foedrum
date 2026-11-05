// A lens step counts its attempts since its latest review (ADR 0324): each round the batch comes back
// to the step has its brewer's attempts afresh, from Foedrum's own defaults, with the fake brewer
// runner and scripted Tasters. No process starts (ADR 0021).

import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { FOEDRUM_DEFAULTS, readBreweryFiles } from '../../src/engine/brewery-files.ts';
import { fold } from '../../src/engine/fold.ts';
import { loadRecipes } from '../../src/engine/recipe-files.ts';
import { openSqliteEventStore } from '../../src/engine/sqlite-event-store.ts';
import type { Event } from '../../src/schemas/events.ts';
import { TastingOutDoc } from '../../src/schemas/out-doc.ts';
import { createBrewing, defaultLimits } from '../helpers/brewing.ts';
import { type Behaviour, behave, fakeBrewerRunner } from '../helpers/fake-brewer-runner.ts';

const done = behave.succeed();
const approves = behave.succeedWith({ verdict: 'approve', findings: [] });
const asksChanges = behave.blocked('findings', 'An Ordered sub-order holds nothing');
const fails = behave.fail(true);

/** The events of an order of issue 1 brewed with the default `recipe`, as the scripts play it. */
const brew = async (
  recipe: string,
  scripts: Record<string, readonly Behaviour[]>,
): Promise<Event[]> => {
  const store = openSqliteEventStore(':memory:');
  try {
    const loaded = loadRecipes(readBreweryFiles(join(FOEDRUM_DEFAULTS, 'no-such-brewery')));
    assert.ok(loaded.valid, loaded.valid ? '' : loaded.problems.join('\n'));
    const brewing = createBrewing({
      store,
      runner: fakeBrewerRunner(scripts),
      recipes: loaded.recipes,
      // A Taster's out doc is read with its verdict; every other step plays a plain one.
      limits: (stepId) =>
        loaded.brewers.find(recipe, stepId)?.brewer.output.schema === 'tasting'
          ? { outDoc: { file: 'out.md', schema: TastingOutDoc } }
          : defaultLimits,
      clock: () => new Date('2026-11-05T12:00:00.000Z'),
    });
    assert.ok(brewing.command({ kind: 'order', batchId: 'b1', order: { issue: 1 } }));
    assert.ok(
      brewing.command({ kind: 'route', batchId: 'b1', recipe, reason: 'label', source: 'label' }),
    );
    await brewing.drive();
    return [...brewing.events()];
  } finally {
    store.close();
  }
};

/** Nip's steps up to its Tasters, with `rounds` rounds of Cellarman, the Finer and the checks. */
const nipUpToTasting = (rounds: number): Record<string, readonly Behaviour[]> => {
  const each = Array.from({ length: rounds }, () => done);
  return {
    survey: [done],
    'survey-check': [done],
    gauge: [done],
    red: [done],
    implement: each,
    fine: each,
    green: each,
    'open-pull-request': [done],
  };
};

const started = (events: readonly Event[]): string[] =>
  events.flatMap((event) => (event.type === 'step.started' ? [event.stepId] : []));

const times = (steps: readonly string[], stepId: string): number =>
  steps.filter((step) => step === stepId).length;

const lane = (events: readonly Event[]) =>
  fold(events).batches.get('b1')?.lane ?? assert.fail('no batch b1');

const assertExhausted = (events: readonly Event[], stepId: string, attempts: number) => {
  const stuck = lane(events);
  assert.equal(stuck.kind, 'stuck', JSON.stringify(stuck));
  const reason = stuck.kind === 'stuck' ? stuck.reason : assert.fail(stuck.kind);
  assert.equal(reason.kind, 'attempts_exhausted', JSON.stringify(reason));
  assert.equal(reason.kind === 'attempts_exhausted' && reason.stepId, stepId);
  assert.equal(reason.kind === 'attempts_exhausted' && reason.attempts, attempts);
};

describe('a lens step counts its attempts since its latest review (ADR 0324)', () => {
  it('a diff lens step that reviewed in an earlier round may fail once in a later round and retry', async () => {
    const steps = started(
      await brew('nip', {
        ...nipUpToTasting(2),
        correctness: [asksChanges, fails, approves],
        acceptance: [approves, approves],
        security: [approves, approves],
      }),
    );
    assert.equal(times(steps, 'correctness'), 3, steps.join(', '));
    assert.equal(steps.at(-1), 'open-pull-request', steps.join(', '));
  });

  it("an advisory Nip Taster's one failure in round 2 does not leave the batch Stuck", async () => {
    const events = await brew('nip', {
      ...nipUpToTasting(2),
      correctness: [asksChanges, approves],
      acceptance: [approves, fails, approves],
      security: [approves, approves],
    });
    const steps = started(events);
    assert.equal(times(steps, 'acceptance'), 3, steps.join(', '));
    assert.equal(steps.at(-1), 'open-pull-request', steps.join(', '));
    assert.notEqual(lane(events).kind, 'stuck', JSON.stringify(lane(events)));
  });

  it('a diff lens step that fails twice in a later round goes Stuck', async () => {
    const events = await brew('nip', {
      ...nipUpToTasting(2),
      correctness: [asksChanges, approves],
      acceptance: [approves, fails, fails, approves],
      security: [approves, approves],
    });
    assert.equal(times(started(events), 'acceptance'), 3, started(events).join(', '));
    assertExhausted(events, 'acceptance', 3);
    assert.ok(!started(events).includes('open-pull-request'), started(events).join(', '));
  });

  it('a diff lens step that fails twice in its first round goes Stuck: regression test', async () => {
    const events = await brew('nip', {
      ...nipUpToTasting(1),
      correctness: [approves],
      acceptance: [fails, fails, approves],
      security: [approves],
    });
    assert.equal(times(started(events), 'acceptance'), 2, started(events).join(', '));
    assertExhausted(events, 'acceptance', 2);
    assert.ok(!started(events).includes('open-pull-request'), started(events).join(', '));
  });

  it('a plan lens step counts as ADR 0321 says, two failures in a later round going Stuck: regression test', async () => {
    const events = await brew('mash', {
      plan: [done, done],
      coverage: [asksChanges, approves],
      sizing: [approves, fails, fails, approves],
      'naive-reader': [approves, approves],
    });
    assert.equal(times(started(events), 'sizing'), 3, started(events).join(', '));
    assertExhausted(events, 'sizing', 3);
  });
});
