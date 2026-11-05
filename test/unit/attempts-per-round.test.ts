// A step counts its attempts per round (ADR 0325): each round a route brings the batch back to it has
// its limit afresh, from Foedrum's own defaults, with the fake brewer runner. No process starts
// (ADR 0021).

import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { FOEDRUM_DEFAULTS, readBreweryFiles } from '../../src/engine/brewery-files.ts';
import { fold } from '../../src/engine/fold.ts';
import { loadRecipes } from '../../src/engine/recipe-files.ts';
import { openSqliteEventStore } from '../../src/engine/sqlite-event-store.ts';
import type { Event } from '../../src/schemas/events.ts';
import { TastingOutDoc } from '../../src/schemas/out-doc.ts';
import type { StepOutcome } from '../../src/schemas/step-outcome.ts';
import { createBrewing, defaultLimits } from '../helpers/brewing.ts';
import { type Behaviour, behave, fakeBrewerRunner } from '../helpers/fake-brewer-runner.ts';

const done = behave.succeed();
const approves = behave.succeedWith({ verdict: 'approve', findings: [] });
const asksChanges = behave.succeedWith(
  {
    verdict: 'changes',
    findings: [{ severity: 'major', why: 'An Ordered sub-order holds nothing', introduced: true }],
  },
  'Changes asked for',
);
const fails = behave.fail(true);

/** A recipe of a Cellarman and a Brett whose survivors send it back once; no default has one. */
const kettle = JSON.stringify({
  name: 'kettle',
  description: 'Brews an order, then has a blocking Brett mutate its change.',
  steps: [
    { id: 'implement', brewer: 'cellarman' },
    {
      id: 'mutate',
      brewer: 'brett',
      blocking: true,
      onBlocked: { findings: { goto: 'implement', maxRounds: 1 } },
    },
    { action: 'openPullRequest' },
  ],
  testFirst: false,
});

const noFiles = readBreweryFiles(join(FOEDRUM_DEFAULTS, 'no-such-brewery'));
const loaded = loadRecipes({
  ...noFiles,
  recipes: [{ path: 'recipes/kettle.jsonc', text: kettle }],
});
assert.ok(loaded.valid, loaded.valid ? '' : loaded.problems.join('\n'));

/** The events of an order of issue 1 brewed with `recipe`, and of a person's `retries` after it. */
const brew = async (
  recipe: string,
  scripts: Record<string, readonly Behaviour[]>,
  retries = 0,
): Promise<Event[]> => {
  const store = openSqliteEventStore(':memory:');
  try {
    const brewing = createBrewing({
      store,
      runner: fakeBrewerRunner(scripts),
      recipes: loaded.recipes,
      // A Taster's out doc is read with its verdict, which on a blocking step blocks by findings;
      // every other step plays a plain one.
      limits: (stepId) => {
        const step = loaded.brewers.find(recipe, stepId);
        if (step?.brewer.output.schema !== 'tasting') return defaultLimits;
        const outDoc = { file: 'out.md', schema: TastingOutDoc };
        return step.blocking === true ? { outDoc, blocking: true } : { outDoc };
      },
      clock: () => new Date('2026-11-05T12:00:00.000Z'),
    });
    assert.ok(brewing.command({ kind: 'order', batchId: 'b1', order: { issue: 1 } }));
    assert.ok(
      brewing.command({ kind: 'route', batchId: 'b1', recipe, reason: 'label', source: 'label' }),
    );
    await brewing.drive();
    for (let left = retries; left > 0; left--) {
      assert.ok(brewing.command({ kind: 'retry', batchId: 'b1', by: 'ada', via: 'terminal' }));
      await brewing.drive();
    }
    return [...brewing.events()];
  } finally {
    store.close();
  }
};

/** Nip with `rounds` rounds of every step from Cellarman to the Tasters, each round passing. */
const nip = (rounds: number): Record<string, readonly Behaviour[]> => {
  const each = (behaviour: Behaviour) => Array.from({ length: rounds }, () => behaviour);
  return {
    survey: [done],
    'survey-check': [done],
    gauge: [done],
    red: [done],
    implement: each(done),
    fine: each(done),
    green: each(done),
    acceptance: each(approves),
    security: each(approves),
    'open-pull-request': [done],
  };
};

/** Nip whose correctness Taster sends the batch back to Cellarman once. */
const nipSentBack = (): Record<string, readonly Behaviour[]> => ({
  ...nip(2),
  correctness: [asksChanges, approves],
});

const ok: StepOutcome = { kind: 'succeeded', output: null };
const failed: StepOutcome = { kind: 'failed', retryable: true, reason: 'the attempt was lost' };

/** A batch whose `stepId` ended each attempt in turn with `outcomes`. */
const batchWith = (stepId: string, outcomes: readonly StepOutcome[]) => {
  const at = '2026-11-05T13:00:00.000Z';
  const events = outcomes.flatMap((outcome, i): Event[] => {
    const ref = { batchId: 'b1', stepId, attempt: i + 1 };
    return [
      { type: 'step.scheduled', ...ref, deadlineAt: at },
      { type: 'step.started', ...ref },
      { type: 'step.finished', ...ref, outcome },
    ];
  });
  const ordered: Event = { type: 'batch.ordered', batchId: 'b1', order: { issue: 1 }, routeBy: at };
  return fold([ordered, ...events]).batches.get('b1') ?? assert.fail('no batch b1');
};

const brewmasterLimit = (): number =>
  loaded.brewers.find('mash', 'plan')?.brewer.maxAttempts ?? assert.fail('no step plan in mash');

const started = (events: readonly Event[]): string[] =>
  events.flatMap((event) => (event.type === 'step.started' ? [event.stepId] : []));

const times = (events: readonly Event[], stepId: string): number =>
  started(events).filter((step) => step === stepId).length;

const lane = (events: readonly Event[]) =>
  fold(events).batches.get('b1')?.lane ?? assert.fail('no batch b1');

/** That the batch went on through `stepId`'s retry, as far as its last step. */
const assertRetried = (events: readonly Event[], stepId: string, count: number, last: string) => {
  assert.equal(times(events, stepId), count, started(events).join(', '));
  assert.equal(started(events).at(-1), last, started(events).join(', '));
  assert.notEqual(lane(events).kind, 'stuck', JSON.stringify(lane(events)));
};

const assertExhausted = (events: readonly Event[], stepId: string, attempts: number) => {
  const stuck = lane(events);
  const reason = stuck.kind === 'stuck' ? stuck.reason : assert.fail(stuck.kind);
  assert.equal(reason.kind, 'attempts_exhausted', JSON.stringify(reason));
  assert.equal(reason.kind === 'attempts_exhausted' && reason.stepId, stepId);
  assert.equal(reason.kind === 'attempts_exhausted' && reason.attempts, attempts);
};

describe('a brewer step counts its attempts since its latest that delivered (ADR 0325)', () => {
  it('Cellarman sent back by a route retries once after one failure in its next round', async () => {
    const events = await brew('nip', { ...nipSentBack(), implement: [done, fails, done] });
    assertRetried(events, 'implement', 3, 'open-pull-request');
  });

  it('the Finer retries once after one failure in a later round', async () => {
    const events = await brew('nip', { ...nipSentBack(), fine: [done, fails, done] });
    assertRetried(events, 'fine', 3, 'open-pull-request');
  });

  it("the Gauger sent back by Cellarman's findings retries once after one failure", async () => {
    const events = await brew('nip', {
      ...nip(1),
      gauge: [done, fails, done],
      red: [done, done],
      implement: [behave.blocked('findings', 'The test expects the wrong slug'), done],
      correctness: [approves],
    });
    assertRetried(events, 'gauge', 3, 'open-pull-request');
  });

  it('a blocking Brett retries once after one failure in a later round', async () => {
    const events = await brew('kettle', {
      implement: [done, done],
      mutate: [behave.blocked('findings', 'A mutant survived'), fails, done],
      'open-pull-request': [done],
    });
    assertRetried(events, 'mutate', 3, 'open-pull-request');
  });

  it("a stuck line says the attempts of this round, within the brewer's limit", async () => {
    const events = await brew('nip', {
      ...nipSentBack(),
      acceptance: [approves, fails, fails, approves],
    });
    assertExhausted(events, 'acceptance', 2);
  });

  it('a brewer step that fails twice in its first round goes Stuck: regression test', async () => {
    const events = await brew('nip', { ...nip(1), implement: [fails, fails, done] });
    assert.equal(times(events, 'implement'), 2, started(events).join(', '));
    assertExhausted(events, 'implement', 2);
    assert.ok(!started(events).includes('fine'), started(events).join(', '));
  });

  it('a step that failed once in its first round and then delivered reads as today: regression test', async () => {
    const events = await brew('nip', {
      ...nip(1),
      implement: [fails, done],
      correctness: [approves],
    });
    assertRetried(events, 'implement', 2, 'open-pull-request');
  });

  it('a step failing every time in a later round goes Stuck within that round', async () => {
    const events = await brew('nip', { ...nipSentBack(), implement: [done, fails, fails, done] });
    assert.equal(times(events, 'implement'), 3, started(events).join(', '));
    assertExhausted(events, 'implement', 2);
  });

  it("a person's retry gives a step that ran out one more, and no more", async () => {
    const events = await brew(
      'nip',
      { ...nipSentBack(), implement: [done, fails, fails, fails, done] },
      1,
    );
    assert.equal(times(events, 'implement'), 4, started(events).join(', '));
    // The number passes the brewer's limit here: the person's attempt is one of this round's.
    assertExhausted(events, 'implement', 3);
  });

  it('a route that runs out of its maxRounds still leaves the batch Stuck: regression test', async () => {
    const events = await brew('nip', {
      ...nip(3),
      correctness: [asksChanges, asksChanges, asksChanges, approves],
    });
    assert.equal(times(events, 'correctness'), 3, started(events).join(', '));
    const stuck = lane(events);
    const reason = stuck.kind === 'stuck' ? stuck.reason : assert.fail(stuck.kind);
    assert.equal(reason.kind, 'blocked', JSON.stringify(reason));
    assert.ok(!started(events).includes('open-pull-request'), started(events).join(', '));
  });

  it('a planner counts as before, its limit of failures after a plan going Stuck: regression test', async () => {
    const limit = brewmasterLimit();
    const events = await brew('mash', {
      plan: [done, ...Array.from({ length: limit }, () => fails), done],
      coverage: [asksChanges, approves],
      sizing: [approves, approves],
      'naive-reader': [approves, approves],
    });
    assert.equal(times(events, 'plan'), 1 + limit, started(events).join(', '));
    const stuck = lane(events);
    assert.equal(stuck.kind === 'stuck' && stuck.reason.kind, 'attempts_exhausted');
  });

  it('a chosen step counts as before, since its latest success: regression test', () => {
    const limit = brewmasterLimit();
    const mash = loaded.recipes.find('mash') ?? assert.fail('no recipe mash');
    const failures = (count: number) => Array.from({ length: count }, () => failed);
    const again = (count: number) => batchWith('lauter', [ok, ok, ...failures(count)]);
    assert.equal(mash.mayRetry(again(limit - 1), 'lauter'), true);
    assert.equal(mash.mayRetry(again(limit), 'lauter'), false);
  });

  it('a block on the environment closes no round, so a retry of it counts it: regression test', async () => {
    const events = await brew(
      'nip',
      {
        ...nip(1),
        implement: [behave.blocked('environment', 'No checkout'), fails, done],
      },
      1,
    );
    assert.equal(times(events, 'implement'), 2, started(events).join(', '));
    assertExhausted(events, 'implement', 2);
  });

  it("the openPullRequest action's stuck number is the attempts of its round: regression test", () => {
    const recipe = loaded.recipes.find('nip') ?? assert.fail('no recipe nip');
    const open = 'open-pull-request';
    assert.equal(recipe.roundAttempts(batchWith(open, [ok, failed, failed, failed]), open), 3);
  });
});

describe('a check step counts its empty reads since its latest reading (ADR 0325)', () => {
  it('a check step counts its empty reads since its latest reading', async () => {
    const events = await brew('nip', {
      ...nip(3),
      green: [fails, fails, done, fails, done],
      correctness: [asksChanges, approves],
    });
    assert.equal(times(events, 'green'), 5, started(events).join(', '));
    // The empty read of round 2 is that round's first: it spends no round of green's route.
    assert.equal(times(events, 'implement'), 2, started(events).join(', '));
    assert.equal(started(events).at(-1), 'open-pull-request', started(events).join(', '));
  });

  it('a third empty read in one round still spends a round of its route: regression test', async () => {
    const events = await brew('nip', {
      ...nip(2),
      green: [fails, fails, fails, done],
      correctness: [approves],
    });
    assert.equal(times(events, 'green'), 4, started(events).join(', '));
    assert.equal(times(events, 'implement'), 2, started(events).join(', '));
    assert.equal(started(events).at(-1), 'open-pull-request', started(events).join(', '));
  });
});
