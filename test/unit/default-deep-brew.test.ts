// Deep-brew, the build stage of the full recipe (ADR 0366): Nip's steps from the survey to the pull
// request, a blocking Brett step whose survivors go back to the Gauger, and one Taster on the
// planner alias through all seven diff lenses together. No test can show a Taster finds anything
// (#879): these pin the recipe's shape, and walk a survivor round through the driver.

import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { attemptLimits } from '../../src/brewers/attempt-plan.ts';
import { settleAttempt } from '../../src/engine/brewer-runner.ts';
import { FOEDRUM_DEFAULTS, readBreweryFiles } from '../../src/engine/brewery-files.ts';
import { createCommandLog } from '../../src/engine/command-log.ts';
import { openDriver } from '../../src/engine/driver.ts';
import { fold } from '../../src/engine/fold.ts';
import { type LoadedRecipes, loadRecipes } from '../../src/engine/recipe-files.ts';
import type { Recipe, RouteWhy } from '../../src/engine/recipes.ts';
import { openSqliteEventStore } from '../../src/engine/sqlite-event-store.ts';
import { defaultLimits } from '../helpers/brewing.ts';
import { type Behaviour, behave, fakeBrewerRunner, outDoc } from '../helpers/fake-brewer-runner.ts';
import { fakeLock } from '../helpers/fake-lock.ts';
import { fakeWorktrees } from '../helpers/fake-worktrees.ts';

// A Brewery with no files of its own: only Foedrum's defaults load.
const noFiles = readBreweryFiles(join(FOEDRUM_DEFAULTS, 'no-such-brewery'));

const loaded = (): Extract<LoadedRecipes, { valid: true }> => {
  const result = loadRecipes(noFiles);
  assert.ok(result.valid, result.valid ? '' : result.problems.join('\n'));
  return result;
};

const found = (name: string): Recipe => loaded().recipes.find(name) ?? assert.fail(`no ${name}`);

const WHYS: readonly RouteWhy[] = ['failed', 'findings', 'pull_request'];

describe('the default deep-brew', () => {
  it("deep-brew loads with type brew and nip's steps from survey to the pull request", () => {
    const { brewers, checks } = loaded();
    const deep = found('deep-brew');
    const nip = found('nip');
    assert.equal(deep.type, 'brew');
    assert.deepEqual(deep.steps, [
      'survey',
      'survey-check',
      'gauge',
      'red',
      'implement',
      'fine',
      'green',
      'mutants',
      'taste',
      'open-pull-request',
    ]);
    // Every step but the tasting and Brett's is Nip's: its brewer, its checks and its routes.
    const tasting = new Set(['taste', ...(nip.children('taste') ?? [])]);
    const shared = nip.steps.filter((id) => !tasting.has(id));
    assert.deepEqual(
      deep.steps.filter((id) => id !== 'mutants' && id !== 'taste'),
      shared,
    );
    const shape = (recipe: string, of: Recipe, id: string) => ({
      brewer: brewers.find(recipe, id)?.brewer.name,
      checks: checks.find(recipe, id),
      proves: checks.proves(recipe, id),
      action: of.action(id),
      proven: of.proven(id),
      routes: WHYS.map((why) => [why, of.routesTo(id, why), of.maxRounds(id, why)]),
    });
    for (const id of shared) {
      assert.deepEqual(shape('deep-brew', deep, id), shape('nip', nip, id), id);
    }
    assert.deepEqual(checks.redProof('deep-brew'), checks.redProof('nip'));
  });

  it('deep-brew tastes through all seven diff lenses in one Taster step on the planner alias', () => {
    const { brewers } = loaded();
    const deep = found('deep-brew');
    assert.equal(deep.children('taste'), undefined, 'one step, not a parallel group');
    const taste = brewers.find('deep-brew', 'taste') ?? assert.fail('no taste step');
    assert.equal(taste.brewer.name, 'taster');
    assert.equal(taste.brewer.model, 'planner');
    // The Taster's own effort, as three lenses together were measured (ADR 0347).
    assert.equal(taste.brewer.effort, 'medium');
    const diffLenses = readdirSync(join(FOEDRUM_DEFAULTS, 'lenses', 'diff'))
      .filter((file) => file.endsWith('.md'))
      .map((file) => `diff/${file.replace(/\.md$/, '')}`);
    assert.equal(diffLenses.length, 7);
    assert.deepEqual([...(taste.together ?? [])].sort(), diffLenses.sort());
  });

  it("deep-brew's Taster findings go back to the Cellarman, two rounds", () => {
    const { brewers } = loaded();
    const deep = found('deep-brew');
    assert.equal(brewers.find('deep-brew', 'taste')?.blocking, true);
    assert.equal(deep.routesTo('taste', 'findings'), 'implement');
    assert.equal(deep.maxRounds('taste', 'findings'), 2);
  });

  it("deep-brew's Brett step blocks and its survivors go back to the Gauger, two rounds", () => {
    const { brewers } = loaded();
    const deep = found('deep-brew');
    const mutants = brewers.find('deep-brew', 'mutants') ?? assert.fail('no mutants step');
    assert.equal(mutants.brewer.name, 'brett');
    assert.equal(mutants.blocking, true);
    assert.equal(deep.routesTo('mutants', 'findings'), 'gauge');
    assert.equal(deep.maxRounds('mutants', 'findings'), 2);
    // Brett before the Taster: a survivor round writes the code again, never past a Taster's fixes.
    assert.ok(deep.steps.indexOf('mutants') < deep.steps.indexOf('taste'));
  });

  it("starts the Gauger a survivor sent back at its own success, without the code, and Cellarman's again at the red proof's tip", async () => {
    const { recipes } = loaded();
    const store = openSqliteEventStore(':memory:');
    const manager = fakeWorktrees();
    const done = behave.succeed();
    const survived = behave.writes(
      outDoc({
        status: 'blocked',
        summary:
          'the tests let a mutant survive: src/a.ts:3: - if (n >= 1) / + if (n > 1): off by one',
        assumptions: [],
        blockerKind: 'findings',
      }),
    );
    const twice = (): Behaviour[] => [done, done];
    const scripts: Record<string, Behaviour[]> = {
      survey: [done],
      'survey-check': [done],
      gauge: twice(),
      red: twice(),
      implement: twice(),
      fine: twice(),
      green: twice(),
      mutants: [survived, done],
      taste: [done],
      'open-pull-request': [done],
    };
    const clock = () => new Date('2026-11-10T12:00:00.000Z');
    const driver = await openDriver({
      store,
      runner: fakeBrewerRunner(({ ref }) => scripts[ref.stepId]?.shift()),
      worktrees: [{ repo: 'acme/api', base: 'origin/main', manager }],
      recipes,
      limits: () => defaultLimits,
      clock,
      lock: () => fakeLock('cellar'),
      takes: () => true,
      stateBranch: { flush: async () => ({ kind: 'unchanged' }) },
    });
    try {
      const intake = createCommandLog({ store, recipes });
      intake.issue({ kind: 'order', batchId: 'b1', order: { issue: 1 } }, clock());
      const route = { kind: 'route', batchId: 'b1', recipe: 'deep-brew', reason: 'label' } as const;
      assert.equal(intake.issue({ ...route, source: 'label' }, clock()).kind, 'accepted');
      await driver.drive();
    } finally {
      driver.close();
    }
    const creates = manager.calls.flatMap((call) =>
      call.kind === 'create' ? [`${call.ref.stepId}#${call.ref.attempt} ${call.base}`] : [],
    );
    assert.deepEqual(creates.slice(7), [
      'mutants#1 refs/heads/foedrum/b1/green/1',
      // Not at the code: the tests that catch the survivor come before it (ADR 0358).
      'gauge#2 refs/heads/foedrum/b1/gauge/1',
      'red#2 refs/heads/foedrum/b1/gauge/2',
      'implement#2 refs/heads/foedrum/b1/red/2',
      'fine#2 refs/heads/foedrum/b1/implement/2',
      'green#2 refs/heads/foedrum/b1/fine/2',
      'mutants#2 refs/heads/foedrum/b1/green/2',
      'taste#1 refs/heads/foedrum/b1/mutants/2',
    ]);
    const events = store.eventsAfter(0).map(({ event }) => event);
    const started = events.flatMap((event) =>
      event.type === 'step.started' ? [event.stepId] : [],
    );
    assert.equal(started.at(-1), 'open-pull-request');
    assert.equal(fold(events).batches.get('b1')?.steps.get('mutants')?.attempts.size, 2);
    store.close();
  });

  it('a sub-order may name deep-brew', () => {
    const { brewers } = loaded();
    const plan = brewers.find('mash', 'plan') ?? assert.fail('mash has no plan step');
    const choice = plan.choices?.find(({ name }) => name === 'deep-brew');
    assert.equal(choice?.type, 'brew');
    // Chosen by what a change can reach, never by its size (ADR 0366).
    assert.match(choice.description, /reach/);
    const subOrder = {
      id: 'api',
      title: 'Build the API',
      repo: 'acme/api',
      size: { lines: 200, mechanism: 'one handler' },
      doneWhen: 'a test passes',
      touches: [{ path: 'src/api.ts' }],
      recipe: 'deep-brew',
      why: 'it reaches every caller',
      ready: true,
    };
    const frontmatter = { status: 'done', summary: 'A plan', subOrders: [subOrder] };
    const ending = settleAttempt(
      {
        exit: { kind: 'exited', code: 0 },
        outDoc: `---\n${JSON.stringify(frontmatter)}\n---\nA plan\n`,
        denials: 0,
        deniedTools: [],
        turns: 3,
      },
      attemptLimits(
        plan.brewer,
        undefined,
        plan.blocking,
        undefined,
        plan.choices?.map(({ name }) => name),
      ),
    );
    assert.equal(ending.kind, 'succeeded', JSON.stringify(ending));
  });
});

describe("the default Gauger on a Brett step's route (ADR 0366)", () => {
  it('adds a test per surviving mutant that fails for the missing behaviour and would catch it', () => {
    const gauge = loaded().brewers.find('nip', 'gauge') ?? assert.fail('no gauge step');
    const sentences = gauge.instructions.split(/(?<=\.)\s+/);
    const survivors = sentences.filter((sentence) => /surviv/i.test(sentence));
    assert.ok(
      survivors.some(
        (sentence) =>
          /\{route\}/.test(sentence) &&
          /a test (for|per) each|each surviv/i.test(sentence) &&
          /fails? for the missing behaviour/i.test(sentence) &&
          /catch/i.test(sentence),
      ),
      survivors.join('\n') || 'the Gauger says nothing of surviving mutants',
    );
  });
});
