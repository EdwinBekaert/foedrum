// The Maltster's map (ADR 0395): Nip and Deep-brew run a read-only `map` step, on the `explorer`
// alias, before the Gauger, and the Gauger, Cellarman and the Finer read its out doc as an input.
// The Maltster's survey, maltster-survey, is unchanged beside it but for its name. The fake brewer
// runner plays every step.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { attemptLimits } from '../../src/brewers/attempt-plan.ts';
import { createAttemptPlans } from '../../src/brewers/attempt-plans.ts';
import { claudeArgs } from '../../src/brewers/claude-command.ts';
import type { OutDocRead } from '../../src/brewers/claude-runner.ts';
import { type ServeSetup, serveSetup } from '../../src/cli/serve-config.ts';
import { FOEDRUM_DEFAULTS, readBreweryFiles } from '../../src/engine/brewery-files.ts';
import { fold } from '../../src/engine/fold.ts';
import { loadRecipes } from '../../src/engine/recipe-files.ts';
import { openSqliteEventStore } from '../../src/engine/sqlite-event-store.ts';
import type { Event } from '../../src/schemas/events.ts';
import { OutDocFrontmatter } from '../../src/schemas/out-doc.ts';
import { createBrewing, defaultLimits } from '../helpers/brewing.ts';
import { type Behaviour, behave, fakeBrewerRunner, outDoc } from '../helpers/fake-brewer-runner.ts';
import { serveInputs } from '../helpers/serve-brewery.ts';

// A Brewery with no recipes/, brewers/ or lenses/ of its own: only Foedrum's defaults load.
const noFiles = readBreweryFiles(join(FOEDRUM_DEFAULTS, 'no-such-brewery'));

/** serve's setup for a Brewery with only Foedrum's defaults, and `models` as its models.jsonc. */
const setupWith = (models: string | undefined): ServeSetup => {
  const given = serveInputs();
  const result = serveSetup({ ...given, files: { ...given.files, models, brewery: noFiles } });
  assert.equal(result.kind, 'ready', result.kind === 'refused' ? result.problems.join('\n') : '');
  return result.kind === 'ready' ? result.setup : assert.fail();
};

const loaded = (files = noFiles) => {
  const result = loadRecipes(files);
  assert.ok(result.valid, result.valid ? '' : result.problems.join('\n'));
  return result;
};

/** The steps the fake runner started for an order brewed with `recipe`, in order. */
const brew = async (
  recipe: string,
  scripts: Record<string, readonly Behaviour[]>,
  files = noFiles,
): Promise<string[]> => {
  const store = openSqliteEventStore(':memory:');
  try {
    const { brewers, recipes } = loaded(files);
    const brewing = createBrewing({
      store,
      runner: fakeBrewerRunner(scripts),
      recipes,
      // A Taster's out doc read with its own schema, as the attempt plan reads it.
      limits: (stepId) => {
        const found = brewers.find(recipe, stepId);
        return found?.lens === undefined
          ? defaultLimits
          : attemptLimits(found.brewer, undefined, found.blocking, found.together);
      },
      clock: () => new Date('2026-11-14T12:00:00.000Z'),
    });
    assert.ok(brewing.command({ kind: 'order', batchId: 'b1', order: { issue: 1 } }));
    assert.ok(
      brewing.command({
        kind: 'route',
        batchId: 'b1',
        recipe,
        reason: 'label',
        source: 'label',
      }),
    );
    await brewing.drive();
    return [...brewing.events()].flatMap((event) =>
      event.type === 'step.started' ? [event.stepId] : [],
    );
  } finally {
    store.close();
  }
};

const done = behave.succeed();
const approves = behave.succeedWith({ verdict: 'approve', findings: [] });
const nipSteps = (more: Record<string, readonly Behaviour[]> = {}) => ({
  survey: [done],
  'survey-check': [done],
  map: [done],
  gauge: [done],
  red: [done],
  implement: [done],
  fine: [done],
  green: [done],
  correctness: [approves],
  acceptance: [approves],
  security: [approves],
  'design-conformance': [approves],
  'open-pull-request': [done],
  ...more,
});

describe('the default Nip and Deep-brew map the code before the Gauger (ADR 0395)', () => {
  it('nip runs the map step after the survey check and before the Gauger', async () => {
    const started = await brew('nip', nipSteps());
    assert.deepEqual(started.slice(0, 4), ['survey', 'survey-check', 'map', 'gauge']);
    assert.equal(started.at(-1), 'open-pull-request');
  });

  it('deep-brew runs the map step after the survey check and before the Gauger', async () => {
    const steps = loaded().recipes.find('deep-brew')?.steps ?? assert.fail('no deep-brew');
    assert.deepEqual(steps.slice(0, 4), ['survey', 'survey-check', 'map', 'gauge']);
  });

  it('nip with test-first off still maps the code, before Cellarman', async () => {
    // Nip with testFirst off, as a Brewery's own copy of it may be (ADR 0064).
    const nipText = readFileSync(join(FOEDRUM_DEFAULTS, 'recipes', 'nip.jsonc'), 'utf8').replace(
      '"name": "nip",',
      '"name": "nip", "testFirst": false,',
    );
    const files = { ...noFiles, recipes: [{ path: 'recipes/nip.jsonc', text: nipText }] };
    const started = await brew('nip', nipSteps(), files);
    assert.deepEqual(started.slice(0, 2), ['map', 'implement']);
  });

  it("nip's map step runs the Maltster's map brewer, read-only on the task tree", () => {
    const found = loaded().brewers.find('nip', 'map') ?? assert.fail('nip has no map step');
    assert.equal(found.brewer.name, 'maltster-map');
    assert.equal(found.brewer.access, 'read');
    assert.equal(found.brewer.model, 'explorer');
    assert.equal(found.brewer.output.doc, 'map.md');
    assert.equal(found.brewer.produces, 'report');
  });

  it("accepts a map out doc that holds only the contract's fields, its map in the body", () => {
    const found = loaded().brewers.find('nip', 'map') ?? assert.fail('nip has no map step');
    const { schema } = attemptLimits(found.brewer).outDoc;
    const read = schema.safeParse({ status: 'done', summary: 'Mapped greet', assumptions: [] });
    assert.ok(read.success, JSON.stringify(read.error));
  });

  it("refuses a map out doc without the contract's status", () => {
    const found = loaded().brewers.find('nip', 'map') ?? assert.fail('nip has no map step');
    const { schema } = attemptLimits(found.brewer).outDoc;
    assert.equal(schema.safeParse({ summary: 'Mapped greet', assumptions: [] }).success, false);
  });

  it("deep-brew's map step runs the same Maltster's map brewer as nip's", () => {
    const found = loaded().brewers.find('deep-brew', 'map') ?? assert.fail('no map step');
    assert.equal(found.brewer.name, 'maltster-map');
    assert.equal(found.brewer.access, 'read');
    assert.equal(found.brewer.model, 'explorer');
  });

  it("keeps the first map when the Tasters' findings send the batch back to Cellarman", async () => {
    const nit = behave.succeedWith({
      verdict: 'approve',
      findings: [{ file: 'a.ts', line: 1, severity: 'minor', why: 'a nit', introduced: true }],
    });
    const started = await brew(
      'nip',
      nipSteps({
        implement: [done, done],
        fine: [done, done],
        green: [done, done],
        correctness: [nit, approves],
        acceptance: [approves, approves],
        security: [approves, approves],
        'design-conformance': [approves, approves],
      }),
    );
    assert.equal(started.filter((step) => step === 'implement').length, 2, started.join(', '));
    assert.equal(started.filter((step) => step === 'map').length, 1, started.join(', '));
  });

  it("keeps the first map when Brett's survivors send the batch back to the Gauger", async () => {
    const survived = behave.writes(
      outDoc({
        status: 'blocked',
        summary: 'the tests let a mutant survive: src/a.ts:3: off by one',
        assumptions: [],
        blockerKind: 'findings',
      }),
    );
    const twice = [done, done];
    const started = await brew('deep-brew', {
      survey: [done],
      'survey-check': [done],
      map: [done],
      gauge: twice,
      red: twice,
      implement: twice,
      fine: twice,
      green: twice,
      mutants: [survived, done],
      taste: [done],
      'open-pull-request': [done],
    });
    assert.equal(started.filter((step) => step === 'gauge').length, 2, started.join(', '));
    assert.equal(started.filter((step) => step === 'map').length, 1, started.join(', '));
  });

  it("runs the Maltster's survey as maltster-survey, its version and fields as they were", () => {
    const { brewers, recipes } = loaded();
    for (const recipe of ['nip', 'deep-brew']) {
      const survey = brewers.find(recipe, 'survey') ?? assert.fail(`${recipe} has no survey`);
      assert.equal(survey.brewer.name, 'maltster-survey', recipe);
      assert.equal(survey.brewer.version, 4, recipe);
      assert.equal(survey.brewer.model, 'builder', recipe);
      assert.deepEqual(survey.brewer.output, { doc: 'survey.md', schema: 'survey' }, recipe);
      assert.deepEqual(survey.brewer.guards, ['requiresOutDoc', 'requiresCommits', 'testMapOnly']);
      assert.deepEqual(recipes.find(recipe)?.steps.slice(0, 2), ['survey', 'survey-check']);
    }
  });
});

const sessionId = '0f8fad5b-d9cb-469f-a165-70867728950e';
const mapRoot = join('/work', 'map-1');
// What the map step left in its worktree: one line per place, which only the map writes.
const MAP_BODY = '## Code\n- src/cli/status.ts:40-72 — prints each batch, which --json replaces\n';
const MAP_DOC = `---\n{ "status": "done", "summary": "Mapped", "assumptions": [] }\n---\n${MAP_BODY}`;

/** Batch 12-1 on Nip, its map step finished when `mapped`, and attempt 1 of `stepId` started. */
const eventsOf = (stepId: string, mapped: boolean): Event[] => {
  const started = (step: string, path: string): Event[] => {
    const ref = { batchId: '12-1', stepId: step, attempt: 1 };
    return [
      { type: 'step.scheduled', ...ref, deadlineAt: '2026-11-14T13:00:00.000Z' },
      {
        type: 'step.started',
        ...ref,
        session: { id: sessionId, worktree: path },
        worktree: {
          repo: 'acme/api',
          path,
          branch: `foedrum/12-1/${step}/1`,
          commit: 'c'.repeat(40),
        },
      },
    ];
  };
  return [
    {
      type: 'batch.ordered',
      batchId: '12-1',
      order: { issue: 12 },
      routeBy: '2026-11-14T13:00:00.000Z',
    },
    { type: 'batch.recipe_chosen', batchId: '12-1', recipe: 'nip', reason: 'l', source: 'label' },
    ...(mapped
      ? [
          ...started('map', mapRoot),
          {
            type: 'step.finished',
            batchId: '12-1',
            stepId: 'map',
            attempt: 1,
            outcome: { kind: 'succeeded', output: { status: 'done', summary: 'Mapped' } },
          } satisfies Event,
        ]
      : []),
    // Cellarman's and the Finer's batch skipped the Gauger: their prompts hold no tests input.
    ...(stepId === 'implement' || stepId === 'fine'
      ? [
          {
            type: 'step.skipped',
            batchId: '12-1',
            stepId: 'gauge',
            when: 'recipe.testFirst',
          } satisfies Event,
        ]
      : []),
    ...(stepId === 'map' ? [] : started(stepId, join('/work', `${stepId}-1`))),
  ];
};

/** The attempt plan of `stepId`, with `models` resolving the aliases and `brewers` the steps. */
const planOf = async (
  stepId: string,
  options: { models?: ServeSetup['models']; brewers?: ServeSetup['brewers'] } = {},
) => {
  const setup = setupWith(undefined);
  const events =
    stepId === 'map' ? [...eventsOf('map', false), ...startedMap()] : eventsOf(stepId, true);
  const plans = createAttemptPlans({
    state: () => fold(events),
    brewers: options.brewers ?? setup.brewers,
    models: options.models ?? setup.models,
    repoTools: () => ['Bash(npm test)'],
    clone: (repo) => join('/clones', repo),
    sandbox: false,
    workRoot: join('/root'),
    env: { base: { PATH: '/usr/bin' }, forced: {} },
    platform: 'linux',
    orderText: async () => 'Add a --json flag to status.',
    orderComments: async () => [],
    git: async () => ({ code: 0, stdout: '', stderr: '' }),
    files: {
      read: (file): OutDocRead =>
        file === join(mapRoot, 'map.md') ? { kind: 'text', text: MAP_DOC } : { kind: 'missing' },
      makeFolder: () => {},
    },
    random: () => Buffer.from('0123456789abcdef0123456789abcdef', 'hex'),
  });
  return plans.plan({
    ref: { batchId: '12-1', stepId, attempt: 1 },
    limits: { outDoc: { file: 'out.md', schema: OutDocFrontmatter } },
  });
};

/** The map step's own attempt, started in its worktree. */
const startedMap = (): Event[] => [
  {
    type: 'step.scheduled',
    batchId: '12-1',
    stepId: 'map',
    attempt: 1,
    deadlineAt: '2026-11-14T13:00:00.000Z',
  },
  {
    type: 'step.started',
    batchId: '12-1',
    stepId: 'map',
    attempt: 1,
    session: { id: sessionId, worktree: mapRoot },
    worktree: {
      repo: 'acme/api',
      path: mapRoot,
      branch: 'foedrum/12-1/map/1',
      commit: 'c'.repeat(40),
    },
  },
];

describe("the map step's attempt and the brewers that read its map (ADR 0395)", () => {
  it('starts claude for the map step on the model the default explorer alias maps to, haiku', async () => {
    const plan = await planOf('map');
    assert.equal(plan.call.model, 'haiku');
    const args = claudeArgs({ ...plan.call, settingsFile: join('/root', 'settings.json') });
    assert.equal(args[args.indexOf('--model') + 1], 'haiku');
  });

  it('gives the map step no tool that writes a file but the edit of its own out doc', async () => {
    const { allow } = (await planOf('map')).permissions;
    for (const tool of ['Read', 'Grep', 'Glob']) assert.ok(allow.includes(tool), allow.join(', '));
    const writes = allow.filter((rule) => /^(?:Edit|Write|MultiEdit|NotebookEdit)\b/.test(rule));
    assert.equal(writes.length, 1, allow.join(', '));
    assert.match(writes[0] ?? '', /^Edit\([^)]*map\.md\)$/);
  });

  it("puts the map step on another model when the Brewery's models.jsonc maps explorer to it", async () => {
    const setup = setupWith(JSON.stringify({ models: { explorer: 'claude-sonnet-5-5' } }));
    const plan = await planOf('map', { models: setup.models });
    assert.equal(plan.call.model, 'claude-sonnet-5-5');
    // The other aliases keep Foedrum's defaults.
    assert.equal(setup.models.models.builder, 'sonnet');
  });

  for (const [stepId, brewer] of [
    ['gauge', 'Gauger'],
    ['implement', 'Cellarman'],
    ['fine', 'Finer'],
  ] as const) {
    it(`puts the map in the ${brewer}'s prompt as a tagged input, and says to start from it`, async () => {
      const { prompt } = await planOf(stepId);
      const [instructions = '', untrusted = ''] = prompt.split('## Untrusted input');
      assert.match(instructions, /\{map\}[^\n]*start from it/);
      assert.ok(
        untrusted.includes(`source="out doc of step map" name="map">\n${MAP_DOC}`),
        untrusted,
      );
    });
  }

  it('gives the Gauger no map input in a recipe without a map step: regression test', async () => {
    // A Brewery's own Nip without the map step, as one made before ADR 0395 is.
    const nipText = readFileSync(join(FOEDRUM_DEFAULTS, 'recipes', 'nip.jsonc'), 'utf8');
    const withoutStep = nipText.replace('{ "id": "map", "brewer": "maltster-map" },', '');
    const { brewers } = loaded({
      ...noFiles,
      recipes: [{ path: 'recipes/nip.jsonc', text: withoutStep }],
    });
    assert.equal(brewers.has('nip', 'map'), false);
    const { prompt } = await planOf('gauge', { brewers });
    assert.match(prompt, /name="order">\nAdd a --json flag to status\.\n/);
    assert.doesNotMatch(prompt, /name="map"/);
    assert.ok(!prompt.includes(MAP_BODY));
  });
});
