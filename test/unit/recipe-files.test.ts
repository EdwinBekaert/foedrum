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
// A recipe whose brewers commit opens its pull request last (ADR 0084).
const opened = (name: string, steps: readonly unknown[], fields = {}): BreweryFile =>
  recipe(name, [...steps, { action: 'openPullRequest' }], fields);
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

  it('lists its steps in the order the recipe gives them, for the status comment (ADR 0072)', () => {
    assert.deepEqual(paleRecipe().steps, ['maltster', 'plan']);
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
      'recipes/pale.jsonc: it names no brewer "maltster" that the Brewery\'s brewers/ or Foedrum\'s defaults have (ADR 0098)',
    ]);
  });

  it('refuses a step the engine does not brew yet, naming its kind', () => {
    const steps = [
      { brewer: 'maltster' },
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
      { action: 'comment' },
      { id: 'split', fanOut: {} },
    ];
    const kinds = ['loop', 'parallel', 'session', 'gate', 'action', 'fanOut'];
    const ids = ['review', 'panel', 'refine', 'approve', 'comment', 'split'];
    assert.deepEqual(
      problemsOf(brewery({ recipes: [recipe('pale', steps)] })),
      ids.map(
        (id, i) =>
          `recipes/pale.jsonc: step "${id}" is a ${kinds[i]} step, which the engine does not brew yet (ADR 0053)`,
      ),
    );
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
      'recipes/pale.jsonc: it names no brewer "gauger" that the Brewery\'s brewers/ or Foedrum\'s defaults have (ADR 0098)',
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
      { id: 'taste', brewer: 'brewmaster', lens: 'plan/security' },
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

describe("loadRecipes: a when that reads the recipe's settings (ADR 0064)", () => {
  const withWhen = (when: string, fields = {}) =>
    loaded(
      loadRecipes(
        brewery({
          recipes: [
            recipe(
              'pale',
              [
                { id: 'gauge', brewer: 'maltster', when },
                { id: 'plan', brewer: 'brewmaster' },
              ],
              fields,
            ),
          ],
        }),
      ),
    ).find('pale');

  it('skips a step whose when is false, naming it, and runs the others', () => {
    const pale = withWhen('recipe.testFirst', { testFirst: false });
    assert.equal(pale?.skip(batch({}), 'gauge'), 'recipe.testFirst');
    assert.equal(pale?.skip(batch({}), 'plan'), undefined);
  });

  it('reads testFirst as resolved: off for a recipe whose brewers commit nothing', () => {
    assert.equal(withWhen('recipe.testFirst')?.skip(batch({}), 'gauge'), 'recipe.testFirst');
  });

  it('compares the setting with a value in single quotes, as text', () => {
    const skips = (when: string) =>
      withWhen(when, { testFirst: false })?.skip(batch({ gauge: 1 }), 'gauge');
    assert.equal(skips("recipe.testFirst == 'false'"), undefined);
    assert.equal(skips("recipe.testFirst != 'true'"), undefined);
    assert.equal(skips("recipe.testFirst == 'true'"), "recipe.testFirst == 'true'");
    assert.equal(skips("recipe.testFirst != 'false'"), "recipe.testFirst != 'false'");
    assert.equal(skips("recipe.testFirst=='false'"), undefined);
  });

  it("refuses a when that reads another step's result, or a setting the recipe has not", () => {
    const steps = [
      { id: 'plan', brewer: 'brewmaster' },
      { id: 'taste', brewer: 'maltster', when: "plan.verdict != 'approve'" },
      { id: 'again', brewer: 'maltster', when: 'recipe.budget' },
    ];
    assert.deepEqual(problemsOf(brewery({ recipes: [recipe('pale', steps)] })), [
      'recipes/pale.jsonc: step "taste" has a "when" that reads step "plan", which the engine does not follow yet (ADR 0064)',
      'recipes/pale.jsonc: step "again" has a "when" that reads recipe.budget, which is not a recipe setting (ADR 0064)',
    ]);
  });
});

describe('loadRecipes: an onBlocked route and its rounds (ADR 0064)', () => {
  type Route = { from: string; why: 'failed' | 'findings' };
  /** A brewing batch whose gauge step has an attempt for each of `routes`, by the route given. */
  const routedBatch = (routes: readonly (Route | undefined)[]): Batch => ({
    ...batch({}),
    steps: new Map([
      [
        'gauge',
        {
          id: 'gauge',
          inputs: [],
          attempts: new Map(
            routes.map((route, i): [number, Attempt] => [
              i + 1,
              {
                phase: 'finished',
                attempt: i + 1,
                deadlineAt: D,
                outcome: { kind: 'succeeded', output: null },
                ...(route === undefined ? {} : { route }),
              },
            ]),
          ),
        },
      ],
    ]),
  });
  const withRoute = (maxRounds: number) => {
    const steps = [
      { id: 'gauge', brewer: 'maltster' },
      {
        id: 'implement',
        brewer: 'brewmaster',
        onBlocked: { findings: { goto: 'gauge', maxRounds } },
      },
    ];
    const found = loaded(loadRecipes(brewery({ recipes: [recipe('pale', steps)] }))).find('pale');
    assert.ok(found !== undefined);
    return found;
  };
  const findings: Route = { from: 'implement', why: 'findings' };

  it('goes back along a findings route while it has rounds left', () => {
    assert.equal(withRoute(1).loopBack(routedBatch([undefined]), 'implement', 'findings'), 'gauge');
    assert.equal(
      withRoute(2).loopBack(routedBatch([undefined, findings]), 'implement', 'findings'),
      'gauge',
    );
  });

  it('counts a round for each attempt the route scheduled, then has none', () => {
    assert.equal(
      withRoute(1).loopBack(routedBatch([undefined, findings]), 'implement', 'findings'),
      undefined,
    );
    assert.equal(
      withRoute(2).loopBack(routedBatch([undefined, findings, findings]), 'implement', 'findings'),
      undefined,
    );
  });

  it('counts only the rounds of its own route', () => {
    const others: Route[] = [
      { from: 'review', why: 'findings' },
      { from: 'implement', why: 'failed' },
    ];
    assert.equal(
      withRoute(1).loopBack(routedBatch([undefined, ...others]), 'implement', 'findings'),
      'gauge',
    );
  });

  it('has no route for a failure, or for a step without onBlocked', () => {
    const pale = withRoute(1);
    assert.equal(pale.loopBack(routedBatch([undefined]), 'implement', 'failed'), undefined);
    assert.equal(pale.loopBack(routedBatch([undefined]), 'gauge', 'findings'), undefined);
  });
});

describe('loadRecipes: a test-first recipe needs a red proof (ADR 0028, ADR 0064)', () => {
  const writer = (name: string) =>
    brewer(name, { access: 'write', tree: 'task', git: { commit: true }, produces: 'commits' });
  const writers = [writer('gauger'), writer('cellarman')];
  const withWriters = (...recipes: BreweryFile[]) =>
    brewery({ recipes, brewers: [maltster, brewmaster, ...writers] });
  const red = { id: 'red', check: 'test', expect: 'fail', of: 'gauge' };
  const noProof = (name: string) =>
    `recipes/${name}.jsonc: it is a test-first recipe without a red proof: add a check step with "expect": "fail" whose "of" names the step that commits the failing tests, or set testFirst: false (ADR 0064)`;
  const proofOfNothing =
    'recipes/pale.jsonc: step "red" proves the tests of step "plan", whose brewer commits nothing (ADR 0078)';

  it('refuses a test-first recipe without a red proof, naming the fix', () => {
    const files = withWriters(
      opened('pale', [{ brewer: 'maltster' }], { testFirst: true }),
      opened('amber', [{ brewer: 'cellarman' }]),
      opened('stout', [{ brewer: 'cellarman' }], { testFirst: false }),
    );
    assert.deepEqual(problemsOf(files), [noProof('pale'), noProof('amber')]);
    const stout = files.recipes.filter(({ path }) => path === 'recipes/stout.jsonc');
    assert.equal(
      loaded(loadRecipes({ ...files, recipes: stout })).find('stout')?.firstStep,
      'cellarman',
    );
  });

  it('refuses a red proof of another step than the first that commits', () => {
    const steps = [
      { id: 'plan', brewer: 'maltster' },
      { id: 'red', check: 'test', expect: 'fail', of: 'plan' },
      { id: 'gauge', brewer: 'gauger' },
    ];
    assert.deepEqual(problemsOf(withWriters(opened('pale', steps))), [
      proofOfNothing,
      noProof('pale'),
    ]);
  });

  it('refuses a step that commits before the red proof, other than the one it proves', () => {
    const steps = [
      { id: 'gauge', brewer: 'gauger' },
      { id: 'implement', brewer: 'cellarman' },
      red,
      { id: 'tidy', brewer: 'cellarman' },
    ];
    assert.deepEqual(problemsOf(withWriters(opened('pale', steps))), [
      'recipes/pale.jsonc: step "implement" commits before the red proof "red" of step "gauge" (ADR 0064)',
    ]);
  });

  it("names a loop's step or a session step's fallback that commits before the red proof", () => {
    const steps = [
      { id: 'gauge', brewer: 'gauger' },
      {
        id: 'review',
        loop: { maxRounds: 1, until: 'fix.status', steps: [{ id: 'fix', brewer: 'cellarman' }] },
      },
      { id: 'refine', session: 'refine', deadline: '1d', fallback: 'cellarman' },
      red,
    ];
    const before = (id: string) =>
      `recipes/pale.jsonc: step "${id}" commits before the red proof "red" of step "gauge" (ADR 0064)`;
    assert.deepEqual(problemsOf(withWriters(opened('pale', steps))), [
      'recipes/pale.jsonc: step "review" is a loop step, which the engine does not brew yet (ADR 0053)',
      'recipes/pale.jsonc: step "refine" is a session step, which the engine does not brew yet (ADR 0053)',
      before('fix'),
      before('refine'),
    ]);
  });

  it('reports a nested brewer the Brewery does not have, instead of resolving the recipe', () => {
    const steps = [
      {
        id: 'review',
        loop: { maxRounds: 1, until: 'fix.status', steps: [{ id: 'fix', brewer: 'nobody' }] },
      },
      { id: 'refine', session: 'refine', deadline: '1d', fallback: 'ghost' },
    ];
    assert.deepEqual(problemsOf(withWriters(opened('pale', steps))), [
      'recipes/pale.jsonc: step "review" is a loop step, which the engine does not brew yet (ADR 0053)',
      'recipes/pale.jsonc: step "refine" is a session step, which the engine does not brew yet (ADR 0053)',
    ]);
  });

  // The steps of a test-first recipe: plan, the Gauger, its red proof, Cellarman, the green check.
  const testFirst = [
    { id: 'plan', brewer: 'maltster' },
    { id: 'gauge', brewer: 'gauger', when: 'recipe.testFirst' },
    { ...red, when: 'recipe.testFirst', onFail: { goto: 'gauge', maxRounds: 1 } },
    { id: 'implement', brewer: 'cellarman' },
    { id: 'green', check: 'test', onFail: { goto: 'implement', maxRounds: 1 } },
  ];

  it('loads a test-first recipe with a red proof, which runs the test check (ADR 0078)', () => {
    const result = loadRecipes(withWriters(opened('pale', testFirst)));
    assert.ok(result.valid, result.valid ? '' : result.problems.join('\n'));
    const pale = result.recipes.find('pale');
    assert.equal(pale?.firstStep, 'plan');
    assert.deepEqual(pale?.after(batch({ gauge: 1 }), 'gauge'), { kind: 'step', stepId: 'red' });
    assert.deepEqual(result.checks.find('pale', 'red'), ['test']);
    // The red proof names the step whose tests it proves; another check step proves none.
    assert.equal(result.checks.proves('pale', 'red'), 'gauge');
    assert.equal(result.checks.proves('pale', 'green'), undefined);
    assert.equal(result.checks.proves('pale', 'gauge'), undefined);
    assert.deepEqual(result.checks.redProof('pale'), { id: 'red', of: 'gauge' });
    assert.equal(result.checks.redProof('elsewhere'), undefined);
  });

  it('runs a step whose when is a bare recipe.testFirst in a test-first recipe (review of #184)', () => {
    const result = loadRecipes(withWriters(opened('pale', testFirst)));
    assert.ok(result.valid, result.valid ? '' : result.problems.join('\n'));
    const pale = result.recipes.find('pale');
    assert.equal(pale?.skip(batch({}), 'gauge'), undefined);
    assert.equal(pale?.skip(batch({}), 'red'), undefined);
  });

  it('routes a failed red proof back to the step it proves, once (ADR 0064, ADR 0069)', () => {
    const result = loadRecipes(withWriters(opened('pale', testFirst)));
    assert.ok(result.valid);
    const pale = result.recipes.find('pale');
    assert.equal(pale?.loopBack(batch({ gauge: 1 }), 'red', 'failed'), 'gauge');
  });

  it("keeps a recipe's first red proof when it has two", () => {
    const steps = [
      { id: 'gauge', brewer: 'gauger' },
      { id: 'red', check: 'test', expect: 'fail', of: 'gauge' },
      { id: 'implement', brewer: 'cellarman' },
      { id: 'again', check: 'test', expect: 'fail', of: 'implement' },
    ];
    const result = loadRecipes(withWriters(opened('pale', steps)));
    assert.ok(result.valid, result.valid ? '' : result.problems.join('\n'));
    assert.deepEqual(result.checks.redProof('pale'), { id: 'red', of: 'gauge' });
    assert.equal(result.checks.proves('pale', 'again'), 'implement');
  });

  it('has no red proof in a recipe without one', () => {
    const steps = [
      { id: 'brew', brewer: 'cellarman' },
      { id: 'green', check: 'test' },
    ];
    const result = loadRecipes(withWriters(opened('stout', steps, { testFirst: false })));
    assert.ok(result.valid, result.valid ? '' : result.problems.join('\n'));
    assert.equal(result.checks.redProof('stout'), undefined);
  });

  it('merges the base before the last check that expects to pass, never before a red proof (ADR 0164)', () => {
    const result = loadRecipes(withWriters(opened('pale', testFirst)));
    assert.ok(result.valid, result.valid ? '' : result.problems.join('\n'));
    const pale = result.recipes.find('pale');
    assert.deepEqual(
      ['plan', 'gauge', 'red', 'implement', 'green', 'open-pull-request'].map((id) =>
        pale?.mergesBase(id),
      ),
      [false, false, false, false, true, false],
    );
  });

  it('merges before the last of two checks only, and in a recipe without a pull request never', () => {
    const steps = [
      { id: 'brew', brewer: 'maltster' },
      { id: 'lint', check: 'lint' },
      { id: 'green', check: 'test' },
    ];
    const result = loadRecipes(
      brewery({ recipes: [opened('stout', steps), recipe('porter', steps)] }),
    );
    assert.ok(result.valid, result.valid ? '' : result.problems.join('\n'));
    const stout = result.recipes.find('stout');
    assert.deepEqual(
      ['brew', 'lint', 'green'].map((id) => stout?.mergesBase(id)),
      [false, false, true],
    );
    const porter = result.recipes.find('porter');
    assert.deepEqual(
      ['brew', 'lint', 'green'].map((id) => porter?.mergesBase(id)),
      [false, false, false],
    );
  });
});

describe('loadRecipes: check steps, the gravity readings (ADR 0069)', () => {
  const e2e = { run: 'make e2e', windows: 'nmake e2e' };
  const ale = recipe('ale', [
    { id: 'brew', brewer: 'maltster' },
    { id: 'green', check: ['typecheck', 'test'] },
    { id: 'e2e', check: e2e, deadline: '2h', onFail: { goto: 'brew', maxRounds: 2 } },
  ]);
  const aleLoaded = () => {
    const result = loadRecipes(brewery({ recipes: [ale] }));
    assert.equal(result.valid, true, result.valid ? '' : result.problems.join('\n'));
    return result as Extract<LoadedRecipes, { valid: true }>;
  };
  const aleRecipe = (): Recipe => {
    const found = aleLoaded().recipes.find('ale');
    assert.ok(found !== undefined);
    return found;
  };

  type Finished = Omit<Extract<Attempt, { phase: 'finished' }>, 'attempt'>;
  /** A brewing batch whose step `stepId` has an attempt for each of `attempts`. */
  const withAttempts = (stepId: string, attempts: readonly Finished[]): Batch => ({
    ...batch({}),
    steps: new Map([
      [
        stepId,
        {
          id: stepId,
          inputs: [],
          attempts: new Map(
            attempts.map((attempt, i): [number, Attempt] => [
              i + 1,
              { ...attempt, attempt: i + 1 },
            ]),
          ),
        },
      ],
    ]),
  });
  const finished = (outcome: Finished['outcome'], route?: Finished['route']): Finished => ({
    phase: 'finished',
    deadlineAt: D,
    outcome,
    ...(route === undefined ? {} : { route }),
  });
  const failedCheck = finished({ kind: 'failed', retryable: false, reason: 'exit code 1' });
  const lost = finished({ kind: 'failed', retryable: true, reason: 'the attempt was lost' });
  const cancelled = finished({ kind: 'cancelled' });

  it('loads a brewer step followed by check steps, in a line', () => {
    const ale = aleRecipe();
    assert.equal(ale.firstStep, 'brew');
    assert.deepEqual(ale.after(batch({}), 'brew'), { kind: 'step', stepId: 'green' });
    assert.deepEqual(ale.after(batch({}), 'green'), { kind: 'step', stepId: 'e2e' });
    assert.deepEqual(ale.after(batch({}), 'e2e'), { kind: 'done', pullRequests: [] });
    assert.equal(ale.has('green'), true);
  });

  it("finds each check step's checks, and no brewer for it", () => {
    const { checks, brewers } = aleLoaded();
    assert.deepEqual(checks.find('ale', 'green'), ['typecheck', 'test']);
    assert.deepEqual(checks.find('ale', 'e2e'), [e2e]);
    assert.equal(checks.find('ale', 'brew'), undefined);
    assert.equal(checks.find('stout', 'green'), undefined);
    assert.equal(brewers.find('ale', 'green'), undefined);
  });

  it('says whether any recipe has a check step', () => {
    assert.equal(aleLoaded().checks.any(), true);
    const result = loadRecipes(brewery());
    assert.ok(result.valid);
    assert.equal(result.checks.any(), false);
  });

  it('gives a check step its own deadline, else 30 minutes, and no stall limit', () => {
    const ale = aleRecipe();
    assert.equal(ale.deadlineMs('green'), 30 * 60_000);
    assert.equal(ale.deadlineMs('e2e'), 2 * 3_600_000);
    assert.equal(ale.stall('green'), undefined);
  });

  it('tries a check step again after an attempt that read nothing, three times over the batch', () => {
    const ale = aleRecipe();
    assert.equal(ale.mayRetry(withAttempts('green', [lost]), 'green'), true);
    assert.equal(ale.mayRetry(withAttempts('green', [lost, cancelled]), 'green'), true);
    assert.equal(ale.mayRetry(withAttempts('green', [lost, cancelled, lost]), 'green'), false);
    // A check that failed read the tree: those attempts do not count, rounds of a route among them.
    const rounds = withAttempts('green', [failedCheck, failedCheck, failedCheck, lost, cancelled]);
    assert.equal(ale.mayRetry(rounds, 'green'), true);
  });

  it('goes back along its onFail route while it has rounds left, then has none (ADR 0064)', () => {
    const ale = aleRecipe();
    const route = { from: 'e2e', why: 'failed' } as const;
    const brewed = finished({ kind: 'succeeded', output: null });
    assert.equal(ale.loopBack(withAttempts('brew', [brewed]), 'e2e', 'failed'), 'brew');
    const once = withAttempts('brew', [brewed, finished(brewed.outcome, route)]);
    assert.equal(ale.loopBack(once, 'e2e', 'failed'), 'brew');
    const twice = withAttempts('brew', [
      brewed,
      finished(brewed.outcome, route),
      finished(brewed.outcome, route),
    ]);
    assert.equal(ale.loopBack(twice, 'e2e', 'failed'), undefined);
    // Only a failed check takes the route, and a check without onFail has none.
    assert.equal(ale.loopBack(withAttempts('brew', [brewed]), 'e2e', 'findings'), undefined);
    assert.equal(ale.loopBack(withAttempts('brew', [brewed]), 'green', 'failed'), undefined);
  });

  it("skips a check step whose when is false for the recipe's settings", () => {
    const steps = [
      { brewer: 'maltster' },
      { id: 'green', check: 'test', when: "recipe.testFirst == 'true'" },
    ];
    const files = brewery({ recipes: [recipe('pale', steps, { testFirst: false })] });
    const found = loaded(loadRecipes(files)).find('pale');
    assert.equal(found?.skip(batch({}), 'green'), "recipe.testFirst == 'true'");
  });

  it('refuses a check step the engine cannot follow yet, one line each', () => {
    const steps = [
      { brewer: 'maltster' },
      { id: 'green', check: 'test', when: 'maltster.status' },
      { id: 'slow', check: 'build', deadline: '366d' },
      { id: 'red', check: 'test', expect: 'fail', of: 'maltster' },
    ];
    assert.deepEqual(
      problemsOf(brewery({ recipes: [recipe('pale', steps, { testFirst: false })] })),
      [
        'recipes/pale.jsonc: step "green" has a "when" that reads step "maltster", which the engine does not follow yet (ADR 0064)',
        'recipes/pale.jsonc: step "slow" has a deadline of 366d, longer than 365 days',
        'recipes/pale.jsonc: step "red" proves the tests of step "maltster", whose brewer commits nothing (ADR 0078)',
      ],
    );
  });
});

describe('loadRecipes: the brewer of each step (#148)', () => {
  const brewersOf = (files: BreweryFiles) => {
    const result = loadRecipes(files);
    assert.equal(result.valid, true);
    return (result as Extract<LoadedRecipes, { valid: true }>).brewers;
  };

  it("finds each step's brewer with its instructions, the brewer file's body", () => {
    const brewers = brewersOf(brewery());
    const plan = brewers.find('pale', 'plan');
    assert.equal(plan?.brewer.name, 'brewmaster');
    assert.equal(plan?.brewer.maxAttempts, 3);
    assert.equal(plan?.instructions.trim(), 'Do the work of the brewmaster.');
    assert.equal(brewers.find('pale', 'maltster')?.brewer.name, 'maltster');
  });

  it('finds nothing for a recipe or a step the Brewery does not have', () => {
    const brewers = brewersOf(brewery());
    assert.equal(brewers.find('stout', 'plan'), undefined);
    assert.equal(brewers.find('pale', 'brewmaster'), undefined);
  });
});

describe('loadRecipes: fails closed on what an attempt plan cannot carry yet (#148)', () => {
  it("refuses a step whose brewer asks for what the engine's attempt plan does not follow yet", () => {
    const cellarman = brewer('cellarman', {
      access: 'write',
      tree: 'task',
      git: { commit: true },
      produces: 'commits',
      retryMode: 'resume',
      houseYeast: true,
      skills: ['tdd'],
      mcp: ['github'],
      context: 'repo',
      toolbox: 'You may use jq.',
      doneWhen: 'The tests pass.',
      guards: ['requiresOutDoc', 'requiresCommits', 'scope'],
    });
    const files = brewery({
      recipes: [opened('stout', [{ id: 'brew', brewer: 'cellarman' }], { testFirst: false })],
      brewers: [maltster, brewmaster, cellarman],
    });
    const refused = (what: string) =>
      `recipes/stout.jsonc: step "brew" has the brewer "cellarman", with ${what}, which the engine does not follow yet (ADR 0059)`;
    assert.deepEqual(problemsOf(files), [
      refused('"houseYeast": true'),
      refused('"skills"'),
      refused('"mcp"'),
      refused('"context": "repo"'),
      refused('"toolbox"'),
      refused('"doneWhen"'),
      refused('the guard "scope"'),
    ]);
  });

  it('refuses a brewer with a tree other than the task tree (ADR 0066)', () => {
    const trees = [
      brewer('blender', { access: 'write', tree: 'integration' }),
      brewer('taster', { access: 'read', tree: 'checkout' }),
      brewer('scribbler', { access: 'write', tree: 'scratch' }),
    ];
    const steps = ['blender', 'taster', 'scribbler'].map((name) => ({ id: name, brewer: name }));
    const files = brewery({
      recipes: [recipe('stout', steps, { testFirst: false })],
      brewers: [maltster, brewmaster, ...trees],
    });
    assert.deepEqual(
      problemsOf(files),
      [
        ['blender', 'integration'],
        ['taster', 'checkout'],
        ['scribbler', 'scratch'],
      ].map(
        ([name, tree]) =>
          `recipes/stout.jsonc: step "${name}" has the brewer "${name}", with "tree": "${tree}", which the engine does not follow yet (ADR 0059)`,
      ),
    );
  });

  it('loads a brewer with the testsUnchanged guard, which the engine follows (ADR 0078)', () => {
    const cellarman = brewer('cellarman', {
      access: 'write',
      tree: 'task',
      git: { commit: true },
      produces: 'commits',
      guards: ['requiresOutDoc', 'testsUnchanged'],
    });
    const files = brewery({
      recipes: [opened('stout', [{ id: 'brew', brewer: 'cellarman' }], { testFirst: false })],
      brewers: [maltster, brewmaster, cellarman],
    });
    assert.equal(loaded(loadRecipes(files)).find('stout')?.firstStep, 'brew');
  });

  it('refuses a brewer that still names noPush, a guard that is gone (ADR 0133)', () => {
    const cellarman = brewer('cellarman', {
      access: 'write',
      tree: 'task',
      git: { commit: true },
      produces: 'commits',
      guards: ['requiresOutDoc', 'noPush'],
    });
    const files = brewery({
      recipes: [opened('stout', [{ id: 'brew', brewer: 'cellarman' }], { testFirst: false })],
      brewers: [maltster, brewmaster, cellarman],
    });
    assert.deepEqual(problemsOf(files), [
      'brewers/cellarman.md: ✖ Invalid option: expected one of "requiresOutDoc"|"requiresCommits"|"testsNotRemoved"|"testsUnchanged"|"scope"|"diffLimits" → at guards[1]',
    ]);
  });

  it('loads a brewer that asks only for what the plan follows, the out doc among its guards', () => {
    const files = brewery({
      brewers: [brewer('maltster', { guards: ['requiresOutDoc'], retryMode: 'fresh' }), brewmaster],
    });
    assert.equal(loaded(loadRecipes(files)).find('pale')?.firstStep, 'maltster');
  });

  it('loads a brewer whose retries and answers resume its session (#327, ADR 0118)', () => {
    const files = brewery({ brewers: [brewer('maltster', { retryMode: 'resume' }), brewmaster] });
    const found = loaded(loadRecipes(files)).find('pale');
    assert.equal(found?.firstStep, 'maltster');
  });

  it('loads requiresCommits: a done of every brewer that produces commits needs a commit (ADR 0074)', () => {
    const cellarman = brewer('cellarman', {
      access: 'write',
      git: { commit: true },
      produces: 'commits',
      guards: ['requiresOutDoc', 'requiresCommits'],
    });
    const files = brewery({
      recipes: [opened('stout', [{ id: 'brew', brewer: 'cellarman' }], { testFirst: false })],
      brewers: [maltster, brewmaster, cellarman],
    });
    assert.equal(loaded(loadRecipes(files)).find('stout')?.firstStep, 'brew');
  });
});

describe('loadRecipes: the openPullRequest action (ADR 0071)', () => {
  const opening = (
    steps: readonly unknown[] = [{ brewer: 'maltster' }, { action: 'openPullRequest' }],
  ) => loadRecipes(brewery({ recipes: [recipe('pale', steps)] }));
  const openingRecipe = (): Recipe => {
    const found = loaded(opening()).find('pale');
    assert.ok(found !== undefined);
    return found;
  };

  it('loads, named after the action in kebab case, as an action the engine runs itself', () => {
    const pale = openingRecipe();
    assert.equal(pale.has('open-pull-request'), true);
    assert.deepEqual(
      ['maltster', 'open-pull-request'].map((id) => pale.action(id)),
      [undefined, 'openPullRequest'],
    );
  });

  it('is done after it, naming the step whose pull request the batch goes on tap with', () => {
    const pale = openingRecipe();
    assert.deepEqual(pale.after(batch({ maltster: 1 }), 'maltster'), {
      kind: 'step',
      stepId: 'open-pull-request',
    });
    assert.deepEqual(
      pale.after(batch({ maltster: 1, 'open-pull-request': 1 }), 'open-pull-request'),
      {
        kind: 'done',
        pullRequests: [],
        opens: 'open-pull-request',
      },
    );
  });

  it('gives it a deadline of two hours, no stall limit, and three attempts', () => {
    const pale = openingRecipe();
    assert.equal(pale.deadlineMs('open-pull-request'), 2 * 3_600_000);
    assert.equal(pale.stall('open-pull-request'), undefined);
    assert.deepEqual(
      [2, 3].map((count) =>
        pale.mayRetry(batch({ 'open-pull-request': count }), 'open-pull-request'),
      ),
      [true, false],
    );
    assert.equal(
      pale.loopBack(batch({ 'open-pull-request': 1 }), 'open-pull-request', 'failed'),
      undefined,
    );
  });

  it("skips it by a when that reads the recipe's settings, as any step", () => {
    const pale = loaded(
      opening([{ brewer: 'maltster' }, { action: 'openPullRequest', when: 'recipe.testFirst' }]),
    ).find('pale');
    assert.equal(pale?.skip(batch({}), 'open-pull-request'), 'recipe.testFirst');
  });

  it('refuses it anywhere but last: the pull request holds the commits of every step', () => {
    assert.deepEqual(
      problemsOf(
        brewery({
          recipes: [recipe('pale', [{ action: 'openPullRequest' }, { brewer: 'maltster' }])],
        }),
      ),
      [
        'recipes/pale.jsonc: step "open-pull-request" opens the pull request, so it must be the last step of the recipe (ADR 0071)',
      ],
    );
  });

  it('gives a recipe without it no action and nothing it opens', () => {
    const pale = paleRecipe();
    assert.equal(pale.action('maltster'), undefined);
    assert.deepEqual(pale.after(batch({ maltster: 1, plan: 1 }), 'plan'), {
      kind: 'done',
      pullRequests: [],
    });
  });
});

describe('loadRecipes: commits end in a pull request (ADR 0084)', () => {
  const cellarman = brewer('cellarman', {
    access: 'write',
    git: { commit: true },
    produces: 'commits',
  });
  const withCellarman = (steps: readonly unknown[]): BreweryFiles =>
    brewery({
      recipes: [recipe('stout', steps, { testFirst: false })],
      brewers: [maltster, cellarman],
    });

  it("counts a nested step's brewer that commits, such as a session's fallback (review of #230)", () => {
    assert.deepEqual(
      problemsOf(
        withCellarman([{ id: 'refine', session: 'refine', deadline: '1d', fallback: 'cellarman' }]),
      ),
      [
        'recipes/stout.jsonc: step "refine" is a session step, which the engine does not brew yet (ADR 0053)',
        'recipes/stout.jsonc: step "refine" has the brewer "cellarman", which produces commits, and no step opens a pull request with them: end the recipe with { "action": "openPullRequest" } (ADR 0084)',
      ],
    );
  });

  it('refuses the action before another step by its place only: it does open the pull request (review of #230)', () => {
    assert.deepEqual(
      problemsOf(
        withCellarman([
          { id: 'brew', brewer: 'cellarman' },
          { action: 'openPullRequest' },
          { id: 'plan', brewer: 'maltster' },
        ]),
      ),
      [
        'recipes/stout.jsonc: step "open-pull-request" opens the pull request, so it must be the last step of the recipe (ADR 0071)',
      ],
    );
  });

  it('refuses a recipe whose brewer commits and that does not end by opening the pull request', () => {
    assert.deepEqual(problemsOf(withCellarman([{ id: 'brew', brewer: 'cellarman' }])), [
      'recipes/stout.jsonc: step "brew" has the brewer "cellarman", which produces commits, and no step opens a pull request with them: end the recipe with { "action": "openPullRequest" } (ADR 0084)',
    ]);
  });

  it('names every step that commits', () => {
    assert.deepEqual(
      problemsOf(
        withCellarman([
          { id: 'brew', brewer: 'cellarman' },
          { id: 'plan', brewer: 'maltster' },
          { id: 'polish', brewer: 'cellarman' },
        ]),
      ),
      ['brew', 'polish'].map(
        (id) =>
          `recipes/stout.jsonc: step "${id}" has the brewer "cellarman", which produces commits, and no step opens a pull request with them: end the recipe with { "action": "openPullRequest" } (ADR 0084)`,
      ),
    );
  });

  it('loads it when it ends with the openPullRequest action', () => {
    const stout = loaded(
      loadRecipes(
        withCellarman([{ id: 'brew', brewer: 'cellarman' }, { action: 'openPullRequest' }]),
      ),
    ).find('stout');
    assert.deepEqual(stout?.steps, ['brew', 'open-pull-request']);
  });

  it('still puts a recipe that commits nothing on tap without a pull request', () => {
    const pale = loaded(loadRecipes(brewery())).find('pale');
    assert.deepEqual(pale?.after(batch({ maltster: 1, plan: 1 }), 'plan'), {
      kind: 'done',
      pullRequests: [],
    });
  });
});

describe("loadRecipes: Foedrum's defaults under the Brewery's files (ADR 0098)", () => {
  const fromDefaults = (file: BreweryFile): BreweryFile => ({
    ...file,
    path: `defaults/${file.path}`,
  });
  const lens = (name: string, text: string, folder = 'lenses/diff'): BreweryFile => ({
    path: `${folder}/${name}.md`,
    text,
  });
  const defaults = {
    recipes: [fromDefaults(pale)],
    brewers: [fromDefaults(maltster), fromDefaults(brewmaster)],
  };
  const valid = (files: BreweryFiles) => {
    const result = loadRecipes(files);
    assert.equal(result.valid, true, result.valid ? '' : result.problems.join('\n'));
    return result as Extract<LoadedRecipes, { valid: true }>;
  };

  it('gives a Brewery with no files of its own the default recipes and brewers, and says which are in use', () => {
    const result = valid({ recipes: [], brewers: [], defaults });
    assert.deepEqual(result.recipes.find('pale')?.steps, ['maltster', 'plan']);
    assert.equal(result.brewers.find('pale', 'plan')?.brewer.maxAttempts, 3);
    assert.deepEqual(result.defaults, [
      'defaults/recipes/pale.jsonc',
      'defaults/brewers/maltster.md',
      'defaults/brewers/brewmaster.md',
    ]);
  });

  it("loads the Brewery's own file instead of the default of the same name, even a broken default", () => {
    const own = brewer('brewmaster', { maxAttempts: 1 });
    const broken = { path: 'defaults/brewers/brewmaster.md', text: 'not a brewer' };
    const result = valid({
      recipes: [],
      brewers: [own],
      defaults: { ...defaults, brewers: [fromDefaults(maltster), broken] },
    });
    assert.equal(result.brewers.find('pale', 'plan')?.brewer.maxAttempts, 1);
    assert.deepEqual(result.defaults, [
      'defaults/recipes/pale.jsonc',
      'defaults/brewers/maltster.md',
    ]);
    // The Brewery's own recipe replaces the default recipe too.
    const ownPale = recipe('pale', [{ brewer: 'maltster' }]);
    const replaced = valid({ recipes: [ownPale], brewers: [], defaults });
    assert.deepEqual(replaced.recipes.find('pale')?.steps, ['maltster']);
    assert.deepEqual(replaced.defaults, [
      'defaults/brewers/maltster.md',
      'defaults/brewers/brewmaster.md',
    ]);
  });

  it('fails the load on a broken default the Brewery does not replace, naming its file', () => {
    const broken = { path: 'defaults/brewers/brewmaster.md', text: 'not a brewer' };
    const problems = problemsOf({
      recipes: [],
      brewers: [],
      defaults: { ...defaults, brewers: [fromDefaults(maltster), broken] },
    });
    assert.ok(
      problems.some((line) => line.startsWith('defaults/brewers/brewmaster.md: ')),
      problems.join('\n'),
    );
  });

  const taster = (from: string) => brewer('taster', { inputs: [{ name: 'focus', from }] });

  it("gives a lens input the Brewery's lens of that name, else the default lens", () => {
    const tasting = recipe('tasting', [{ id: 'taste', brewer: 'taster' }]);
    const files = (lenses: BreweryFile[]): BreweryFiles => ({
      recipes: [tasting],
      brewers: [taster('lens:diff/test-design')],
      lenses,
      defaults: { lenses: [lens('test-design', 'Look at the tests.', 'defaults/lenses/diff')] },
    });
    const lensOf = (result: Extract<LoadedRecipes, { valid: true }>) =>
      result.brewers.find('tasting', 'taste')?.lenses?.get('diff/test-design');
    const fromDefault = valid(files([]));
    assert.deepEqual(lensOf(fromDefault), {
      name: 'diff/test-design',
      path: 'defaults/lenses/diff/test-design.md',
      text: 'Look at the tests.',
    });
    assert.deepEqual(fromDefault.defaults, ['defaults/lenses/diff/test-design.md']);
    const own = valid(files([lens('test-design', 'Look at our tests.')]));
    assert.deepEqual(lensOf(own), {
      name: 'diff/test-design',
      path: 'lenses/diff/test-design.md',
      text: 'Look at our tests.',
    });
    assert.deepEqual(own.defaults, []);
  });

  it('refuses a brewer whose lens input names a lens neither the Brewery nor the defaults have, naming the brewer and the lens', () => {
    assert.deepEqual(
      problemsOf({
        recipes: [],
        brewers: [taster('lens:diff/sparkle')],
        defaults: { lenses: [lens('test-design', 'Look at the tests.', 'defaults/lenses/diff')] },
      }),
      [
        'brewers/taster.md: the brewer "taster" has the input "focus" from the lens "diff/sparkle", which neither the Brewery\'s lenses/ nor Foedrum\'s defaults have (ADR 0098)',
      ],
    );
  });

  it('fails the load on a lens file it could not read', () => {
    assert.deepEqual(
      problemsOf({
        recipes: [],
        brewers: [],
        lenses: [{ path: 'lenses/diff/security.md', unreadable: 'EACCES: permission denied' }],
      }),
      ['lenses/diff/security.md: EACCES: permission denied'],
    );
  });

  it('names an unreadable lens once, not also as a lens its brewer lacks', () => {
    assert.deepEqual(
      problemsOf({
        recipes: [],
        brewers: [taster('lens:diff/security')],
        lenses: [{ path: 'lenses/diff/security.md', unreadable: 'EACCES: permission denied' }],
        defaults: { lenses: [lens('security', 'Look for secrets.', 'defaults/lenses/diff')] },
      }),
      ['lenses/diff/security.md: EACCES: permission denied'],
    );
  });

  it("refuses a lens larger than a brewer's input may be, and loads one at the limit", () => {
    const atLimit = 'é'.repeat(512 * 1024);
    assert.deepEqual(
      problemsOf({ recipes: [], brewers: [], lenses: [lens('security', `${atLimit}x`)] }),
      [
        "lenses/diff/security.md: it is larger than 1048576 bytes, the limit of a brewer's input (ADR 0098)",
      ],
    );
    valid({ recipes: [], brewers: [], lenses: [lens('security', atLimit)] });
  });

  it('keeps an unreadable defaults folder even when a Brewery file has its name', () => {
    const folder = { path: 'defaults/brewers', unreadable: 'ENOTDIR: not a directory' };
    const problems = problemsOf({
      recipes: [],
      brewers: [brewer('brewers')],
      defaults: { brewers: [folder] },
    });
    assert.ok(problems.includes('defaults/brewers: ENOTDIR: not a directory'), problems.join('\n'));
  });

  it('names an unreadable lenses/ folder once, not also every lens its brewers name', () => {
    assert.deepEqual(
      problemsOf({
        recipes: [],
        brewers: [taster('lens:diff/mine')],
        lenses: [{ path: 'lenses', unreadable: 'EACCES: permission denied' }],
      }),
      ['lenses: EACCES: permission denied'],
    );
  });

  it('names a lens too large once, not also as a lens its brewer lacks', () => {
    const tooLarge = lens('security', 'x'.repeat(1024 * 1024 + 1));
    assert.deepEqual(
      problemsOf({ recipes: [], brewers: [taster('lens:diff/security')], lenses: [tooLarge] }),
      [
        "lenses/diff/security.md: it is larger than 1048576 bytes, the limit of a brewer's input (ADR 0098)",
      ],
    );
  });
});

describe('loadRecipes: lenses in two folders, lenses/diff/ and lenses/plan/ (ADR 0143)', () => {
  const lensFile = (path: string, text = '# Lens\n'): BreweryFile => ({ path, text });
  const committer = brewer('cellarman', {
    access: 'write',
    git: { commit: true },
    produces: 'commits',
  });
  const reviewing = (steps: readonly unknown[]): BreweryFiles => ({
    recipes: [recipe('amber', steps, { testFirst: false })],
    brewers: [maltster, committer],
  });

  it('fails a step that reviews a plan, since no step before it commits, and names a diff/ lens', () => {
    const problems = problemsOf(
      reviewing([
        { brewer: 'maltster' },
        { id: 'taste', brewer: 'maltster', lens: 'diff/security' },
      ]),
    );
    assert.ok(
      problems.includes(
        'recipes/amber.jsonc: step "taste" reviews a plan, since no step before it commits, and names the lens "diff/security", which reviews a diff: name a lens of lenses/plan/ (ADR 0143)',
      ),
      problems.join('\n'),
    );
  });

  it('fails a step that reviews a diff, since a step before it commits, and names a plan/ lens', () => {
    const problems = problemsOf(
      reviewing([
        { brewer: 'cellarman' },
        { id: 'taste', brewer: 'maltster', lens: 'plan/coverage' },
        { action: 'openPullRequest' },
      ]),
    );
    assert.ok(
      problems.includes(
        'recipes/amber.jsonc: step "taste" reviews a diff, since step "cellarman" before it commits, and names the lens "plan/coverage", which reviews a plan: name a lens of lenses/diff/ (ADR 0143)',
      ),
      problems.join('\n'),
    );
  });

  it('gives no folder line for a lens of the folder its step reviews', () => {
    const plan = problemsOf(
      reviewing([{ id: 'taste', brewer: 'maltster', lens: 'plan/coverage' }]),
    );
    const diff = problemsOf(
      reviewing([
        { brewer: 'cellarman' },
        { id: 'taste', parallel: [{ brewer: 'maltster', lens: 'diff/security' }] },
        { action: 'openPullRequest' },
      ]),
    );
    for (const line of [...plan, ...diff]) assert.ok(!line.includes('ADR 0143'), line);
  });

  it('reads nested steps too: a lens step in a parallel group, and a step in a loop that commits', () => {
    const nestedLens = problemsOf(
      reviewing([
        { brewer: 'cellarman' },
        { id: 'tasting', parallel: [{ id: 'taste', brewer: 'maltster', lens: 'plan/coverage' }] },
        { action: 'openPullRequest' },
      ]),
    );
    assert.ok(
      nestedLens.includes(
        'recipes/amber.jsonc: step "taste" reviews a diff, since step "cellarman" before it commits, and names the lens "plan/coverage", which reviews a plan: name a lens of lenses/diff/ (ADR 0143)',
      ),
      nestedLens.join('\n'),
    );
    const nestedCommit = problemsOf(
      reviewing([
        {
          id: 'fixing',
          loop: { maxRounds: 1, until: 'fix.status', steps: [{ id: 'fix', brewer: 'cellarman' }] },
        },
        { id: 'taste', brewer: 'maltster', lens: 'plan/coverage' },
        { action: 'openPullRequest' },
      ]),
    );
    assert.ok(
      nestedCommit.includes(
        'recipes/amber.jsonc: step "taste" reviews a diff, since step "fix" before it commits, and names the lens "plan/coverage", which reviews a plan: name a lens of lenses/diff/ (ADR 0143)',
      ),
      nestedCommit.join('\n'),
    );
  });

  it('counts only a step before the lens step as the one that commits, not the step itself or one after it', () => {
    const after = problemsOf(
      reviewing([
        { id: 'taste', brewer: 'maltster', lens: 'plan/coverage' },
        { brewer: 'cellarman' },
        { action: 'openPullRequest' },
      ]),
    );
    const itself = problemsOf(
      reviewing([
        { id: 'taste', brewer: 'cellarman', lens: 'plan/coverage' },
        { action: 'openPullRequest' },
      ]),
    );
    for (const line of [...after, ...itself]) assert.ok(!line.includes('ADR 0143'), line);
  });

  it('says where a lens directly in lenses/ belongs even when it cannot be read or is too large', () => {
    const misplaced =
      'lenses/security.md: a lens belongs in lenses/diff/, to review a diff, or lenses/plan/, to review a plan (ADR 0143)';
    for (const file of [
      { path: 'lenses/security.md', unreadable: 'EACCES: permission denied' },
      lensFile('lenses/security.md', 'x'.repeat(1024 * 1024 + 1)),
    ]) {
      assert.deepEqual(problemsOf({ recipes: [], brewers: [], lenses: [file] }), [misplaced]);
    }
  });

  it('fails a lens file directly in lenses/, saying where it belongs, in the Brewery and in the defaults', () => {
    assert.deepEqual(
      problemsOf({
        recipes: [],
        brewers: [],
        lenses: [lensFile('lenses/security.md')],
        defaults: { lenses: [lensFile('defaults/lenses/style.md')] },
      }),
      [
        'lenses/security.md: a lens belongs in lenses/diff/, to review a diff, or lenses/plan/, to review a plan (ADR 0143)',
        'defaults/lenses/style.md: a lens belongs in defaults/lenses/diff/, to review a diff, or defaults/lenses/plan/, to review a plan (ADR 0143)',
      ],
    );
  });

  it('replaces only the default of the same folder and name', () => {
    const result = loadRecipes({
      recipes: [],
      brewers: [],
      lenses: [lensFile('lenses/plan/security.md')],
      defaults: {
        lenses: [
          lensFile('defaults/lenses/diff/security.md'),
          lensFile('defaults/lenses/plan/security.md'),
        ],
      },
    });
    assert.equal(result.valid, true, result.valid ? '' : result.problems.join('\n'));
    assert.deepEqual(result.valid && result.defaults, ['defaults/lenses/diff/security.md']);
  });

  it('gives a brewer input the lens of the folder it names', () => {
    const result = loadRecipes({
      recipes: [recipe('amber', [{ id: 'taste', brewer: 'taster' }])],
      brewers: [brewer('taster', { inputs: [{ name: 'focus', from: 'lens:plan/security' }] })],
      defaults: {
        lenses: [
          lensFile('defaults/lenses/diff/security.md', 'the diff'),
          lensFile('defaults/lenses/plan/security.md', 'the plan'),
        ],
      },
    });
    assert.equal(result.valid, true, result.valid ? '' : result.problems.join('\n'));
    assert.deepEqual(
      result.valid && result.brewers.find('amber', 'taste')?.lenses,
      new Map([
        [
          'plan/security',
          { name: 'plan/security', path: 'defaults/lenses/plan/security.md', text: 'the plan' },
        ],
      ]),
    );
  });
});
