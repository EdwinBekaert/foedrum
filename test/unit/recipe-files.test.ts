// The Brewery's recipe files as the engine's Recipes (ADR 0053): a recipe of brewer steps in a
// line loads, with its brewers' deadlines, stall limits and attempts; anything else fails the
// whole load with one line per problem, the line doctor and a refused command give.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Attempt, Batch } from '../../src/engine/fold.ts';
import {
  type BreweryFile,
  type BreweryFiles,
  INVALID_RECIPES,
  invalidRecipes,
  type LoadedRecipes,
  loadRecipes,
} from '../../src/engine/recipe-files.ts';
import type { Recipe } from '../../src/engine/recipes.ts';
import { brewerText, recipeText } from '../helpers/brewery-files.ts';

const recipe = (name: string, steps: readonly unknown[], fields = {}): BreweryFile => ({
  path: `recipes/${name}.jsonc`,
  text: recipeText(name, steps, fields),
});
const brewer = (name: string, fields = {}): BreweryFile => ({
  path: `brewers/${name}.md`,
  text: brewerText(name, fields),
});

// The pale recipe: a maltster with its own deadline and stall, then a brewmaster with a deadline
// of its step's own and three attempts.
const pale = recipe('pale', [
  { brewer: 'maltster' },
  { id: 'plan', brewer: 'brewmaster', deadline: '90s' },
]);
const maltster = brewer('maltster', { deadline: '2h', stall: { turns: 10, minutes: 5 } });
const brewmaster = brewer('brewmaster', { maxAttempts: 3 });
const brewery = (files: Partial<BreweryFiles> = {}): BreweryFiles => ({
  recipes: [pale],
  brewers: [maltster, brewmaster],
  ...files,
});

const loaded = (result: LoadedRecipes) => {
  assert.equal(result.valid, true, result.valid ? '' : result.problems.join('\n'));
  return (result as Extract<LoadedRecipes, { valid: true }>).recipes;
};
const paleRecipe = (): Recipe => {
  const found = loaded(loadRecipes(brewery())).find('pale');
  assert.ok(found !== undefined);
  return found;
};

const problemsOf = (files: BreweryFiles): readonly string[] => {
  const result = loadRecipes(files);
  assert.equal(result.valid, false, 'the files should not load');
  return (result as Extract<LoadedRecipes, { valid: false }>).problems;
};

const D = '2026-10-16T10:00:00.000Z';
/** A brewing batch with `count` attempts at each step. */
const batch = (attempts: Record<string, number>): Batch => ({
  id: '12-1',
  issue: 12,
  lane: { kind: 'brewing' },
  rewinds: [],
  steps: new Map(
    Object.entries(attempts).map(([id, count]) => [
      id,
      {
        id,
        inputs: [],
        attempts: new Map(
          Array.from({ length: count }, (_, i): [number, Attempt] => [
            i + 1,
            { phase: 'scheduled', attempt: i + 1, deadlineAt: D },
          ]),
        ),
      },
    ]),
  ),
});

describe('loadRecipes: a recipe of brewer steps in a line', () => {
  it('starts with its first step, a brewer step named after its brewer', () => {
    const pale = paleRecipe();
    assert.equal(pale.firstStep, 'maltster');
    assert.deepEqual(
      ['maltster', 'plan', 'brewmaster', 'pale'].map((id) => pale.has(id)),
      [true, true, false, false],
    );
  });

  it('goes from step to step, and is done with no pull request after the last', () => {
    const pale = paleRecipe();
    assert.deepEqual(pale.after(batch({ maltster: 1 }), 'maltster'), {
      kind: 'step',
      stepId: 'plan',
    });
    assert.deepEqual(pale.after(batch({ maltster: 1, plan: 1 }), 'plan'), {
      kind: 'done',
      pullRequests: [],
    });
  });

  it("gives each step its own deadline, else its brewer's", () => {
    const pale = paleRecipe();
    assert.equal(pale.deadlineMs('maltster'), 2 * 3_600_000);
    assert.equal(pale.deadlineMs('plan'), 90_000);
  });

  it('reads deadlines in seconds, minutes, hours and days', () => {
    const steps = ['1s', '7m', '3h', '2d'].map((deadline, i) => ({
      id: `s${i}`,
      brewer: 'maltster',
      deadline,
    }));
    const found = loaded(loadRecipes(brewery({ recipes: [recipe('pale', steps)] }))).find('pale');
    assert.deepEqual(
      steps.map(({ id }) => found?.deadlineMs(id)),
      [1_000, 7 * 60_000, 3 * 3_600_000, 2 * 86_400_000],
    );
  });

  it("gives each step its brewer's stall limit, or none", () => {
    const pale = paleRecipe();
    assert.deepEqual(pale.stall('maltster'), { turns: 10, minutes: 5 });
    assert.equal(pale.stall('plan'), undefined);
  });

  it("retries a step while it has had fewer attempts than its brewer's maxAttempts", () => {
    const pale = paleRecipe();
    assert.deepEqual(
      [1, 2].map((count) => pale.mayRetry(batch({ maltster: count }), 'maltster')),
      [true, false],
    );
    assert.deepEqual(
      [2, 3].map((count) => pale.mayRetry(batch({ plan: count }), 'plan')),
      [true, false],
    );
  });

  it('has no route back', () => {
    const pale = paleRecipe();
    for (const why of ['failed', 'findings'] as const) {
      assert.equal(pale.loopBack(batch({ plan: 1 }), 'plan', why), undefined);
    }
  });

  it('finds recipes by name only, and loads a Brewery without recipe files', () => {
    const recipes = loaded(
      loadRecipes(brewery({ recipes: [pale, recipe('amber', [{ brewer: 'brewmaster' }])] })),
    );
    assert.equal(recipes.find('amber')?.firstStep, 'brewmaster');
    assert.equal(recipes.find('stout'), undefined);
    assert.equal(loaded(loadRecipes({ recipes: [], brewers: [] })).find('pale'), undefined);
  });

  it('ignores the recipe settings the engine has no use for yet', () => {
    const fields = { match: { labels: ['feature'] }, budget: { minutes: 60 }, testFirst: false };
    const files = brewery({ recipes: [recipe('pale', [{ brewer: 'maltster' }], fields)] });
    assert.equal(loaded(loadRecipes(files)).find('pale')?.firstStep, 'maltster');
  });
});

describe('loadRecipes: fails closed', () => {
  it('loads no recipe at all when one file is not valid', () => {
    const broken = { path: 'recipes/amber.jsonc', text: '{ "name": ' };
    const problems = problemsOf(brewery({ recipes: [pale, broken] }));
    assert.equal(problems.length, 1);
    assert.match(problems[0] ?? '', /^recipes\/amber\.jsonc: \S/);
  });

  it('says in one line why a recipe does not pass its schema', () => {
    const fields = { budget: { minutes: 0 } };
    const files = brewery({ recipes: [recipe('pale', [{ brewer: 'maltster' }], fields)] });
    const [problem, ...rest] = problemsOf(files);
    assert.deepEqual(rest, []);
    assert.match(problem ?? '', /^recipes\/pale\.jsonc: .*budget\.minutes/);
    assert.doesNotMatch(problem ?? '', /\n/);
  });

  it('says in one line why a brewer does not pass its schema', () => {
    const files = brewery({ brewers: [maltster, brewer('brewmaster', { maxAttempts: 0 })] });
    const [problem, ...rest] = problemsOf(files);
    assert.deepEqual(rest, []);
    assert.match(problem ?? '', /^brewers\/brewmaster\.md: .*maxAttempts/);
    assert.doesNotMatch(problem ?? '', /\n/);
  });

  it('refuses a file that could not be read, with the reason', () => {
    const files = brewery({
      brewers: [maltster, { path: 'brewers/brewmaster.md', unreadable: 'EACCES: denied' }],
    });
    assert.deepEqual(problemsOf(files), ['brewers/brewmaster.md: EACCES: denied']);
  });

  it('refuses a recipe or brewer file not named after what it holds', () => {
    const files = brewery({
      recipes: [{ ...pale, path: 'recipes/amber.jsonc' }],
      brewers: [{ ...maltster, path: 'brewers/malt.md' }, brewmaster],
    });
    assert.deepEqual(problemsOf(files), [
      'brewers/malt.md: it holds the brewer "maltster", which belongs in brewers/maltster.md',
      'recipes/amber.jsonc: it holds the recipe "pale", which belongs in recipes/pale.jsonc',
    ]);
  });

  it('refuses a recipe that names a brewer the Brewery does not have', () => {
    assert.deepEqual(problemsOf(brewery({ brewers: [brewmaster] })), [
      'recipes/pale.jsonc: it names no brewer "maltster" the Brewery has',
    ]);
  });

  it('refuses a step the engine does not brew yet, naming its kind', () => {
    const steps = [
      { brewer: 'maltster' },
      { id: 'green', check: 'test' },
      {
        id: 'review',
        loop: {
          maxRounds: 1,
          until: 'taste.verdict',
          steps: [{ id: 'taste', brewer: 'brewmaster' }],
        },
      },
      { id: 'panel', parallel: [{ brewer: 'brewmaster' }] },
      { id: 'refine', session: 'refine', deadline: '1d' },
      { id: 'approve', gate: 'human', deadline: '1d' },
      { action: 'openPullRequest' },
      { id: 'split', fanOut: {} },
    ];
    const kinds = ['check', 'loop', 'parallel', 'session', 'gate', 'action', 'fanOut'];
    const ids = ['green', 'review', 'panel', 'refine', 'approve', 'open-pull-request', 'split'];
    assert.deepEqual(
      problemsOf(brewery({ recipes: [recipe('pale', steps)] })),
      ids.map(
        (id, i) =>
          `recipes/pale.jsonc: step "${id}" is a ${kinds[i]} step, which the engine does not brew yet (ADR 0053)`,
      ),
    );
  });

  it('refuses a brewer step with a condition or a route, which the engine does not follow yet', () => {
    const steps = [
      { id: 'plan', brewer: 'brewmaster' },
      { brewer: 'maltster', when: 'plan.status' },
      {
        id: 'again',
        brewer: 'maltster',
        onBlocked: { findings: { goto: 'plan', maxRounds: 1 } },
      },
    ];
    assert.deepEqual(problemsOf(brewery({ recipes: [recipe('pale', steps)] })), [
      'recipes/pale.jsonc: step "maltster" has a "when", which the engine does not follow yet (ADR 0053)',
      'recipes/pale.jsonc: step "again" has an "onBlocked" route, which the engine does not follow yet (ADR 0053)',
    ]);
  });

  it('reports every problem of every file, brewers first, and a broken brewer file once', () => {
    const files = brewery({
      recipes: [
        { path: 'recipes/amber.jsonc', unreadable: 'EISDIR' },
        recipe('pale', [{ brewer: 'maltster' }, { brewer: 'gauger' }]),
      ],
      brewers: [{ path: 'brewers/maltster.md', unreadable: 'EACCES' }, brewmaster],
    });
    // The maltster's file is there, so the recipe does not also name a brewer it lacks.
    assert.deepEqual(problemsOf(files), [
      'brewers/maltster.md: EACCES',
      'recipes/amber.jsonc: EISDIR',
      'recipes/pale.jsonc: it names no brewer "gauger" the Brewery has',
    ]);
  });
});

describe('invalidRecipes', () => {
  it("is doctor's line: what is wrong, then each problem", () => {
    assert.equal(
      invalidRecipes(['brewers/maltster.md: EACCES', 'recipes/amber.jsonc: EISDIR']),
      `${INVALID_RECIPES}: brewers/maltster.md: EACCES; recipes/amber.jsonc: EISDIR`,
    );
  });
});

describe('loadRecipes: fails closed on what a brewer step cannot do yet (#151)', () => {
  it('refuses a lens or a blocking flag, which the engine does not follow yet', () => {
    const steps = [
      { id: 'taste', brewer: 'brewmaster', lens: 'security' },
      { id: 'mutants', brewer: 'maltster', blocking: true },
    ];
    assert.deepEqual(problemsOf(brewery({ recipes: [recipe('pale', steps)] })), [
      'recipes/pale.jsonc: step "taste" has a "lens", which the engine does not follow yet (ADR 0053)',
      'recipes/pale.jsonc: step "mutants" has "blocking", which the engine does not follow yet (ADR 0053)',
    ]);
  });

  it('refuses a deadline longer than 365 days, which a step could not be scheduled with', () => {
    const files = brewery({
      recipes: [
        recipe('pale', [
          { brewer: 'maltster' },
          { id: 'plan', brewer: 'brewmaster', deadline: '999999999999h' },
        ]),
      ],
      brewers: [brewer('maltster', { deadline: '366d' }), brewmaster],
    });
    assert.deepEqual(problemsOf(files), [
      'recipes/pale.jsonc: step "maltster" has a deadline of 366d, longer than 365 days',
      'recipes/pale.jsonc: step "plan" has a deadline of 999999999999h, longer than 365 days',
    ]);
    const year = recipe('pale', [{ brewer: 'maltster', deadline: '365d' }]);
    assert.equal(
      loaded(loadRecipes(brewery({ recipes: [year] })))
        .find('pale')
        ?.deadlineMs('maltster'),
      365 * 86_400_000,
    );
  });
});

describe('loadRecipes: test-first recipes (ADR 0028, #25)', () => {
  it('refuses a recipe that resolves to test-first, saying to set testFirst: false', () => {
    const cellarman = brewer('cellarman', {
      access: 'write',
      tree: 'task',
      git: { commit: true },
      produces: 'commits',
    });
    const files = brewery({
      recipes: [
        recipe('pale', [{ brewer: 'maltster' }], { testFirst: true }),
        recipe('amber', [{ brewer: 'cellarman' }]),
        recipe('stout', [{ brewer: 'cellarman' }], { testFirst: false }),
      ],
      brewers: [maltster, brewmaster, cellarman],
    });
    const refused = (name: string) =>
      `recipes/${name}.jsonc: it is a test-first recipe, which the engine does not brew yet: set testFirst: false until test-first recipes land (#25) (ADR 0053)`;
    assert.deepEqual(problemsOf(files), [refused('pale'), refused('amber')]);
    const stout = files.recipes.filter(({ path }) => path === 'recipes/stout.jsonc');
    assert.equal(
      loaded(loadRecipes({ ...files, recipes: stout })).find('stout')?.firstStep,
      'cellarman',
    );
  });
});
