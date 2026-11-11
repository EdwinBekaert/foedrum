// A recipe's type (ADR 0365): `mash` chooses a recipe or makes a plan and builds nothing, `brew`
// builds. Every recipe file has one, the defaults included; what a step is offered follows it, and
// a plan's sub-orders run only with recipes of type brew.

import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { attemptLimits } from '../../src/brewers/attempt-plan.ts';
import { settleAttempt } from '../../src/engine/brewer-runner.ts';
import { readBreweryFiles } from '../../src/engine/brewery-files.ts';
import {
  type BreweryFile,
  type BreweryFiles,
  type LoadedRecipes,
  loadRecipes,
} from '../../src/engine/recipe-files.ts';
import { brewerText, recipeText } from '../helpers/brewery-files.ts';

// The defaults under a Brewery with no files of its own.
const defaults = (): BreweryFiles =>
  readBreweryFiles(join(import.meta.dirname, '..', '..', 'no-brewery'));

/** A Brewery recipe that plans under a name of its own: the Brewmaster alone. */
const wort: BreweryFile = {
  path: 'recipes/wort.jsonc',
  text: recipeText('wort', [{ id: 'plan', brewer: 'brewmaster' }], {
    type: 'mash',
    testFirst: false,
  }),
};

const valid = (result: LoadedRecipes): Extract<LoadedRecipes, { valid: true }> => {
  assert.ok(result.valid, result.valid ? '' : result.problems.join('\n'));
  return result;
};

const problemsOf = (files: BreweryFiles): readonly string[] => {
  const result = loadRecipes(files);
  assert.ok(!result.valid, 'the files should not load');
  return result.problems;
};

/** The recipe file `name` as `recipeText` writes it, with no `type`. */
const untyped = (name: string): BreweryFile => {
  const { type: _, ...rest } = JSON.parse(
    recipeText(name, [{ brewer: 'brewmaster' }]).replace(/^\/\/.*\n/, ''),
  );
  return { path: `recipes/${name}.jsonc`, text: JSON.stringify(rest) };
};

describe('a recipe file and its type (ADR 0365)', () => {
  it('refuses a recipe with no type when it loads, naming the file and the fix', () => {
    const problems = problemsOf({ ...defaults(), recipes: [untyped('stout')] });
    assert.equal(problems.length, 1, problems.join('\n'));
    assert.match(
      problems[0] ?? '',
      /^recipes\/stout\.jsonc: .*add "type": "mash" when it chooses a recipe or makes a plan and builds nothing, or "type": "brew" when it builds/,
    );
  });

  it('refuses a type other than mash or brew, naming the two', () => {
    const text = recipeText('stout', [{ brewer: 'brewmaster' }], { type: 'plan' });
    const problems = problemsOf({
      ...defaults(),
      recipes: [{ path: 'recipes/stout.jsonc', text }],
    });
    assert.match(problems.join('\n'), /^recipes\/stout\.jsonc: .*Must be "mash".*or "brew"/m);
  });

  it('loads the default recipes with mash-in, mash and deep-mash as mash and nip as brew', () => {
    const { recipes } = valid(loadRecipes(defaults()));
    const typeOf = (name: string) => recipes.find(name)?.type;
    assert.deepEqual(['mash-in', 'mash', 'deep-mash', 'nip'].map(typeOf), [
      'mash',
      'mash',
      'mash',
      'brew',
    ]);
  });
});

describe('what a step is offered, by type (ADR 0365)', () => {
  it("offers the Innkeeper every recipe that does not choose one, a Brewery's own of type mash too, each with its type", () => {
    const loaded = valid(loadRecipes({ ...defaults(), recipes: [wort] }));
    const offered = loaded.brewers
      .find('mash-in', 'innkeep')
      ?.choices?.map(({ name, type }) => `${name} ${type}`);
    assert.deepEqual(offered, [
      'wort mash',
      'deep-brew brew',
      'deep-mash mash',
      'mash mash',
      'nip brew',
    ]);
  });

  it('offers the Brewmaster and a plan lens step only the recipes of type brew', () => {
    const loaded = valid(loadRecipes({ ...defaults(), recipes: [wort] }));
    const names = (recipe: string, step: string) =>
      loaded.brewers.find(recipe, step)?.choices?.map(({ name }) => name);
    assert.deepEqual(names('wort', 'plan'), ['deep-brew', 'nip']);
    assert.deepEqual(names('deep-mash', 'recipe-fit'), ['deep-brew', 'nip']);
  });

  it('offers a plan brewer without a recipes input the recipes of type brew, which its sub-orders run with', () => {
    const sketcher: BreweryFile = {
      path: 'brewers/sketcher.md',
      text: brewerText('sketcher', { output: { doc: 'plan.md', schema: 'plan' } }),
    };
    const sketch: BreweryFile = {
      path: 'recipes/sketch.jsonc',
      text: recipeText('sketch', [{ id: 'plan', brewer: 'sketcher' }], { type: 'mash' }),
    };
    const loaded = valid(loadRecipes({ ...defaults(), recipes: [sketch], brewers: [sketcher] }));
    const step = loaded.brewers.find('sketch', 'plan');
    assert.ok(!step?.brewer.inputs.some(({ from }) => from === 'recipes'));
    assert.deepEqual(
      step?.choices?.map(({ name }) => name),
      ['deep-brew', 'nip'],
    );
  });
});

describe("a plan's sub-orders run with recipes of type brew (ADR 0365)", () => {
  /** How the plan attempt of `recipe`'s step `plan` ends whose one sub-order names `named`. */
  const planned = (recipe: string, named: string) => {
    const loaded = valid(loadRecipes({ ...defaults(), recipes: [wort] }));
    const step = loaded.brewers.find(recipe, 'plan') ?? assert.fail(`${recipe} has no plan step`);
    const subOrder = {
      id: 'api',
      title: 'Build the API',
      repo: 'acme/api',
      size: { lines: 200, mechanism: 'one handler' },
      doneWhen: 'a test passes',
      touches: [{ path: 'src/api.ts' }],
      recipe: named,
      why: 'it fits',
      ready: true,
    };
    const frontmatter = { status: 'done', summary: 'A plan', subOrders: [subOrder] };
    return settleAttempt(
      {
        exit: { kind: 'exited', code: 0 },
        outDoc: `---\n${JSON.stringify(frontmatter)}\n---\nA plan\n`,
        denials: 0,
        deniedTools: [],
        turns: 3,
      },
      attemptLimits(
        step.brewer,
        undefined,
        step.blocking,
        undefined,
        step.choices?.map(({ name }) => name),
      ),
    );
  };

  it("refuses a sub-order that names the Brewery's own recipe of type mash, under a new name", () => {
    const ending = planned('mash', 'wort');
    assert.ok(ending.kind === 'failed' && ending.retryable, JSON.stringify(ending));
    assert.match(
      ending.reason,
      /^the out doc plan\.md is invalid: .*recipes of type brew, deep-brew, nip: not wort[\s\S]*subOrders\[0\]\.recipe/,
    );
  });

  it('takes a sub-order that names a recipe of type brew (regression test)', () => {
    assert.equal(planned('wort', 'nip').kind, 'succeeded');
  });
});
