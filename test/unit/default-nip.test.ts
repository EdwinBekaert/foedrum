// Nip and the Gauger, Foedrum's default test-first recipe and brewer (#218, ADR 0017): a Brewery
// without files of its own plans Nip's steps from the defaults, and the Gauger's prompt holds the
// test-design lens's checklist, passed in as an input (ADR 0022, ADR 0098).

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { createAttemptPlans } from '../../src/brewers/attempt-plans.ts';
import { FOEDRUM_DEFAULTS, readBreweryFiles } from '../../src/engine/brewery-files.ts';
import { fold } from '../../src/engine/fold.ts';
import { type LoadedRecipes, loadRecipes } from '../../src/engine/recipe-files.ts';
import { openSqliteEventStore } from '../../src/engine/sqlite-event-store.ts';
import type { Event } from '../../src/schemas/events.ts';
import { OutDocFrontmatter } from '../../src/schemas/out-doc.ts';
import { createBrewing } from '../helpers/brewing.ts';
import { type Behaviour, behave, fakeBrewerRunner } from '../helpers/fake-brewer-runner.ts';

// A Brewery with no recipes/, brewers/ or lenses/ of its own: a folder that does not exist has
// none, so only Foedrum's defaults load.
const noFiles = readBreweryFiles(join(FOEDRUM_DEFAULTS, 'no-such-brewery'));

const valid = (result: LoadedRecipes) => {
  assert.ok(result.valid, result.valid ? '' : result.problems.join('\n'));
  return result;
};

/** The steps an order brewed with the default Nip started, in order, as the fake runner plays them. */
const brewNip = async (scripts: Record<string, readonly Behaviour[]>): Promise<string[]> => {
  const store = openSqliteEventStore(':memory:');
  try {
    const brewing = createBrewing({
      store,
      runner: fakeBrewerRunner(scripts),
      recipes: valid(loadRecipes(noFiles)).recipes,
      clock: () => new Date('2026-10-21T12:00:00.000Z'),
    });
    assert.ok(brewing.command({ kind: 'order', batchId: 'b1', order: { issue: 1 } }));
    assert.ok(
      brewing.command({
        kind: 'route',
        batchId: 'b1',
        recipe: 'nip',
        reason: 'label',
        source: 'label',
      }),
    );
    await brewing.drive();
    return brewing
      .events()
      .flatMap((event) => (event.type === 'step.started' ? [event.stepId] : []));
  } finally {
    store.close();
  }
};

describe('the default Nip', () => {
  it('sends a Cellarman that finds a test wrong back to the Gauger, once (ADR 0017, ADR 0064)', async () => {
    const done = behave.succeed();
    const started = await brewNip({
      gauge: [done, done],
      red: [done, done],
      implement: [behave.blocked('findings', 'The test expects the wrong slug'), done],
      green: [done],
      'open-pull-request': [done],
    });
    assert.deepEqual(started, [
      'gauge',
      'red',
      'implement',
      'gauge',
      'red',
      'implement',
      'green',
      'open-pull-request',
    ]);
  });

  it('sends a Cellarman whose change fails the green checks back to try again, once', async () => {
    const done = behave.succeed();
    const started = await brewNip({
      gauge: [done],
      red: [done],
      implement: [done, done],
      green: [behave.fail(false), done],
      'open-pull-request': [done],
    });
    assert.deepEqual(started, [
      'gauge',
      'red',
      'implement',
      'green',
      'implement',
      'green',
      'open-pull-request',
    ]);
  });

  it('goes no further when the red proof refuses the tests a second time', async () => {
    const done = behave.succeed();
    const started = await brewNip({
      gauge: [done, done, done],
      red: [behave.fail(false), behave.fail(false), done],
      implement: [done],
    });
    assert.deepEqual(started, ['gauge', 'red', 'gauge', 'red']);
  });

  it('sends a Gauger whose tests the red proof refuses back to write them again, once', async () => {
    const done = behave.succeed();
    const started = await brewNip({
      gauge: [done, done],
      red: [behave.fail(false), done],
      implement: [done],
      green: [done],
      'open-pull-request': [done],
    });
    assert.deepEqual(started, [
      'gauge',
      'red',
      'gauge',
      'red',
      'implement',
      'green',
      'open-pull-request',
    ]);
  });

  it("gives Cellarman the Gauger's out doc and the testsUnchanged guard, and both brewers commit", () => {
    const { brewers } = valid(loadRecipes(noFiles));
    const cellarman = brewers.find('nip', 'implement')?.brewer;
    assert.ok(cellarman !== undefined, 'nip has no implement step');
    assert.ok(cellarman.guards.includes('testsUnchanged'), JSON.stringify(cellarman.guards));
    assert.ok(
      cellarman.inputs.some(({ from }) => from === 'step:gauge'),
      JSON.stringify(cellarman.inputs),
    );
    for (const step of ['gauge', 'implement']) {
      const brewer = brewers.find('nip', step)?.brewer;
      assert.equal(brewer?.produces, 'commits', step);
      assert.ok(brewer.guards.includes('requiresCommits'), step);
    }
  });

  it("plans Nip's steps from the defaults in a Brewery without its own nip.jsonc and gauger.md", () => {
    const loaded = valid(loadRecipes(noFiles));
    assert.deepEqual(loaded.recipes.find('nip')?.steps, [
      'gauge',
      'red',
      'implement',
      'green',
      'open-pull-request',
    ]);
    assert.equal(loaded.brewers.find('nip', 'gauge')?.brewer.name, 'gauger');
    assert.equal(loaded.brewers.find('nip', 'implement')?.brewer.name, 'cellarman');
    assert.deepEqual(loaded.checks.redProof('nip'), { id: 'red', of: 'gauge' });
    assert.deepEqual(loaded.checks.find('nip', 'green'), ['build', 'lint', 'format', 'test']);
    for (const path of [
      'defaults/recipes/nip.jsonc',
      'defaults/brewers/gauger.md',
      'defaults/brewers/cellarman.md',
    ]) {
      assert.ok(loaded.defaults.includes(path), `${path} is not in ${loaded.defaults.join(', ')}`);
    }
  });

  it('brews an order through each of its steps, in order, with the fake brewer runner', async () => {
    const store = openSqliteEventStore(':memory:');
    try {
      const done = behave.succeed();
      const brewing = createBrewing({
        store,
        // The check steps and the action play on the fake runner too: this is about the recipe's
        // line, not what each step does.
        runner: fakeBrewerRunner(
          Object.fromEntries(
            ['gauge', 'red', 'implement', 'green', 'open-pull-request'].map((id) => [id, [done]]),
          ),
        ),
        recipes: valid(loadRecipes(noFiles)).recipes,
        clock: () => new Date('2026-10-21T12:00:00.000Z'),
      });
      assert.ok(brewing.command({ kind: 'order', batchId: 'b1', order: { issue: 1 } }));
      assert.ok(
        brewing.command({
          kind: 'route',
          batchId: 'b1',
          recipe: 'nip',
          reason: 'label',
          source: 'label',
        }),
      );
      await brewing.drive();
      const started = brewing
        .events()
        .flatMap((event) => (event.type === 'step.started' ? [event.stepId] : []));
      assert.deepEqual(started, ['gauge', 'red', 'implement', 'green', 'open-pull-request']);
    } finally {
      store.close();
    }
  });
});

describe('the default Gauger', () => {
  const gauger = () => valid(loadRecipes(noFiles)).brewers.find('nip', 'gauge');

  it('says up front that stubs throw "not implemented" and that test names are the runner\'s', () => {
    const found = gauger();
    assert.ok(found !== undefined, 'nip has no gauge step');
    // The first section: everything before the second heading.
    const [upFront = ''] = found.instructions.split(/\n(?=## )/).filter((part) => part.trim());
    assert.match(upFront, /throw[^\n]*not implemented/i);
    assert.match(upFront, /names? the (?:test )?runner reports/i);
  });

  it("holds the test-design lens's checklist in its prompt, as an input, not a copy", async () => {
    const found = gauger();
    assert.ok(found !== undefined, 'nip has no gauge step');
    const lens = readFileSync(join(FOEDRUM_DEFAULTS, 'lenses', 'test-design.md'), 'utf8');
    // Not repeated in the brewer file: the brewer and the Taster read the one checklist.
    const copied = lens
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 40 && found.instructions.includes(line));
    assert.deepEqual(copied, []);

    const ref = { batchId: '12-1', stepId: 'gauge', attempt: 1 };
    const events: Event[] = [
      {
        type: 'batch.ordered',
        batchId: '12-1',
        order: { issue: 12 },
        routeBy: '2026-10-21T13:00:00.000Z',
      },
      {
        type: 'batch.recipe_chosen',
        batchId: '12-1',
        recipe: 'nip',
        reason: 'label',
        source: 'label',
      },
      { type: 'step.scheduled', ...ref, deadlineAt: '2026-10-21T13:00:00.000Z' },
      {
        type: 'step.started',
        ...ref,
        worktree: {
          repo: 'acme/api',
          path: join('/work', 'gauge-1'),
          branch: 'foedrum/12-1/gauge/1',
          commit: 'c'.repeat(40),
        },
      },
    ];
    const plans = createAttemptPlans({
      state: () => fold(events),
      brewers: valid(loadRecipes(noFiles)).brewers,
      models: { models: { builder: 'claude-sonnet-5-5' }, brewers: {} },
      repoTools: () => [],
      clone: (repo) => join('/clones', repo),
      sandbox: false,
      workRoot: join('/root'),
      env: { base: { PATH: '/usr/bin' }, forced: {} },
      platform: 'linux',
      orderText: async () => 'Add a --json flag to status.',
      files: {
        read: () => ({ kind: 'missing' }),
        makeFolder: () => {},
      },
      sessionId: () => '0f8fad5b-d9cb-469f-a165-70867728950e',
      random: () => Buffer.from('0123456789abcdef0123456789abcdef', 'hex'),
    });
    const { prompt } = await plans.plan({
      ref,
      limits: { outDoc: { file: 'gauge.md', schema: OutDocFrontmatter } },
    });
    assert.ok(
      prompt.includes(
        `source="lens test-design, file defaults/lenses/test-design.md" name="testDesign">\n${lens}\n</`,
      ),
      'the prompt does not hold the lens as an input',
    );
    assert.match(prompt, /source="issue #12 body" name="order">\nAdd a --json flag to status\.\n/);
  });
});
