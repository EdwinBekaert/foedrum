// Nip and the Gauger, Foedrum's default test-first recipe and brewer (#218, ADR 0017): a Brewery
// without files of its own plans Nip's steps from the defaults, and the Gauger's prompt holds the
// test-design lens's checklist, passed in as an input (ADR 0022, ADR 0098).

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { routeInput, routeOf } from '../../src/brewers/attempt-plan.ts';
import { createAttemptPlans } from '../../src/brewers/attempt-plans.ts';
import type { PromptInput } from '../../src/brewers/prompt.ts';
import { FOEDRUM_DEFAULTS, readBreweryFiles } from '../../src/engine/brewery-files.ts';
import { fold } from '../../src/engine/fold.ts';
import { type LoadedRecipes, loadRecipes } from '../../src/engine/recipe-files.ts';
import { openSqliteEventStore } from '../../src/engine/sqlite-event-store.ts';
import type { Event, GravityReading } from '../../src/schemas/events.ts';
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
      taste: [done],
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
      'taste',
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
      taste: [done],
      'open-pull-request': [done],
    });
    assert.deepEqual(started, [
      'gauge',
      'red',
      'implement',
      'green',
      'implement',
      'green',
      'taste',
      'open-pull-request',
    ]);
  });

  it("records a failed green check's route so the Cellarman's second attempt reads the failing test (#341, ADR 0128)", async () => {
    const store = openSqliteEventStore(':memory:');
    try {
      const done = behave.succeed();
      const failing: GravityReading = {
        result: 'exited',
        check: 'test',
        command: 'npm test',
        exitCode: 1,
        tail: 'not ok 3 - status --json prints the batches',
      };
      const scripts: Record<string, Behaviour[]> = {
        gauge: [done],
        red: [done],
        implement: [done, done],
        green: [behave.read([failing]), done],
        taste: [done],
        'open-pull-request': [done],
      };
      const { brewers, recipes } = valid(loadRecipes(noFiles));
      // What each attempt of implement would be told about why it runs, when it starts.
      const told: (PromptInput | undefined)[] = [];
      const brewing = createBrewing({
        store,
        runner: fakeBrewerRunner((attempt) => {
          const { stepId } = attempt.ref;
          if (stepId === 'implement') {
            const batch = fold(brewing.events()).batches.get('b1');
            assert.ok(batch !== undefined);
            const outDocOf = (id: string) => brewers.find('nip', id)?.brewer.output.doc;
            const route = routeOf(batch, attempt.ref, outDocOf);
            told.push(route === undefined ? undefined : routeInput(route));
          }
          return scripts[stepId]?.shift();
        }),
        recipes,
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
      assert.equal(told.length, 2);
      assert.equal(told[0], undefined, 'the first attempt was told why it runs again');
      assert.deepEqual(told[1]?.source, {
        kind: 'route',
        step: 'implement',
        from: 'green',
        why: 'failed',
      });
      assert.match(told[1]?.text ?? '', /the check "test" \(npm test\) failed with exit code 1/);
      assert.match(told[1]?.text ?? '', /not ok 3 - status --json prints the batches/);
    } finally {
      store.close();
    }
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
      taste: [done],
      'open-pull-request': [done],
    });
    assert.deepEqual(started, [
      'gauge',
      'red',
      'gauge',
      'red',
      'implement',
      'green',
      'taste',
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

  it("has Cellarman write the pull request's sections, its out doc schema pullRequest (ADR 0167)", () => {
    const { brewers } = valid(loadRecipes(noFiles));
    assert.equal(brewers.find('nip', 'implement')?.brewer.output.schema, 'pullRequest');
  });

  it('has the Gauger name its new tests and regression tests, its out doc schema gauge (ADR 0170)', () => {
    const { brewers } = valid(loadRecipes(noFiles));
    assert.equal(brewers.find('nip', 'gauge')?.brewer.output.schema, 'gauge');
  });

  it("plans Nip's steps from the defaults in a Brewery without its own nip.jsonc and gauger.md", () => {
    const loaded = valid(loadRecipes(noFiles));
    assert.deepEqual(loaded.recipes.find('nip')?.steps, [
      'gauge',
      'red',
      'implement',
      'green',
      'taste',
      'open-pull-request',
    ]);
    assert.equal(loaded.brewers.find('nip', 'gauge')?.brewer.name, 'gauger');
    assert.equal(loaded.brewers.find('nip', 'implement')?.brewer.name, 'cellarman');
    // After green, the Taster reviews through the correctness lens; its findings are advisory.
    const taste = loaded.brewers.find('nip', 'taste');
    assert.equal(taste?.brewer.name, 'taster');
    assert.deepEqual([...(taste?.lenses?.keys() ?? [])], ['diff/correctness']);
    assert.equal(taste?.blocking, false);
    assert.deepEqual(loaded.checks.redProof('nip'), { id: 'red', of: 'gauge' });
    for (const path of [
      'defaults/recipes/nip.jsonc',
      'defaults/brewers/gauger.md',
      'defaults/brewers/cellarman.md',
      'defaults/brewers/taster.md',
    ]) {
      assert.ok(loaded.defaults.includes(path), `${path} is not in ${loaded.defaults.join(', ')}`);
    }
  });

  it("reads the typecheck in Nip's green step, after the build and before lint (#411)", () => {
    const loaded = valid(loadRecipes(noFiles));
    assert.deepEqual(loaded.checks.find('nip', 'green'), [
      'build',
      'typecheck',
      'lint',
      'format',
      'test',
    ]);
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
            ['gauge', 'red', 'implement', 'green', 'taste', 'open-pull-request'].map((id) => [
              id,
              [done],
            ]),
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
      assert.deepEqual(started, [
        'gauge',
        'red',
        'implement',
        'green',
        'taste',
        'open-pull-request',
      ]);
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
    assert.ok(found.lenses?.has('diff/test-design'), 'the gauger names no lens diff/test-design');
    const lens = readFileSync(join(FOEDRUM_DEFAULTS, 'lenses', 'diff', 'test-design.md'), 'utf8');
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
        session: { id: '0f8fad5b-d9cb-469f-a165-70867728950e', worktree: join('/work', 'gauge-1') },
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
      random: () => Buffer.from('0123456789abcdef0123456789abcdef', 'hex'),
    });
    const { prompt } = await plans.plan({
      ref,
      limits: { outDoc: { file: 'gauge.md', schema: OutDocFrontmatter } },
    });
    assert.ok(
      prompt.includes(
        `source="lens diff/test-design, file defaults/lenses/diff/test-design.md" name="testDesign">\n${lens}\n</`,
      ),
      'the prompt does not hold the lens as an input',
    );
    assert.match(prompt, /source="issue #12 body" name="order">\nAdd a --json flag to status\.\n/);
  });
});
