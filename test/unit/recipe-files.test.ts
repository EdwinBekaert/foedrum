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
  const unbrewedCheck =
    'recipes/pale.jsonc: step "red" is a check step, which the engine does not brew yet (ADR 0053)';

  it('refuses a test-first recipe without a red proof, naming the fix', () => {
    const files = withWriters(
      recipe('pale', [{ brewer: 'maltster' }], { testFirst: true }),
      recipe('amber', [{ brewer: 'cellarman' }]),
      recipe('stout', [{ brewer: 'cellarman' }], { testFirst: false }),
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
    assert.deepEqual(problemsOf(withWriters(recipe('pale', steps))), [
      unbrewedCheck,
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
    assert.deepEqual(problemsOf(withWriters(recipe('pale', steps))), [
      unbrewedCheck,
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
    assert.deepEqual(problemsOf(withWriters(recipe('pale', steps))), [
      'recipes/pale.jsonc: step "review" is a loop step, which the engine does not brew yet (ADR 0053)',
      'recipes/pale.jsonc: step "refine" is a session step, which the engine does not brew yet (ADR 0053)',
      unbrewedCheck,
      before('fix'),
      before('refine'),
    ]);
  });

  it('refuses a test-first recipe for no more than its check steps, which the engine does not brew yet', () => {
    const steps = [
      { id: 'plan', brewer: 'maltster' },
      { id: 'gauge', brewer: 'gauger', when: 'recipe.testFirst' },
      { ...red, when: 'recipe.testFirst' },
      { id: 'implement', brewer: 'cellarman' },
    ];
    assert.deepEqual(problemsOf(withWriters(recipe('pale', steps))), [unbrewedCheck]);
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
      guards: ['requiresOutDoc', 'noPush', 'requiresCommits', 'scope'],
    });
    const files = brewery({
      recipes: [recipe('stout', [{ id: 'brew', brewer: 'cellarman' }], { testFirst: false })],
      brewers: [maltster, brewmaster, cellarman],
    });
    const refused = (what: string) =>
      `recipes/stout.jsonc: step "brew" has the brewer "cellarman", with ${what}, which the engine does not follow yet (ADR 0059)`;
    assert.deepEqual(problemsOf(files), [
      refused('"retryMode": "resume"'),
      refused('"houseYeast": true'),
      refused('"skills"'),
      refused('"mcp"'),
      refused('"context": "repo"'),
      refused('"toolbox"'),
      refused('"doneWhen"'),
      refused('the guard "noPush"'),
      refused('the guard "requiresCommits"'),
      refused('the guard "scope"'),
    ]);
  });

  it('loads a brewer that asks only for what the plan follows, the out doc among its guards', () => {
    const files = brewery({
      brewers: [brewer('maltster', { guards: ['requiresOutDoc'], retryMode: 'fresh' }), brewmaster],
    });
    assert.equal(loaded(loadRecipes(files)).find('pale')?.firstStep, 'maltster');
  });
});
