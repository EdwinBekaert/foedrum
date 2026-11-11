import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { readBreweryFiles } from '../../src/engine/brewery-files.ts';
import { loadRecipes } from '../../src/engine/recipe-files.ts';
import { readJsonc } from '../../src/schemas/read.ts';
import { DefaultRecipe } from '../../src/schemas/recipe.ts';

const root = join(import.meta.dirname, '..', '..', 'defaults');
// Default brewers and lenses are Markdown, so every JSONC file under defaults/ is a recipe
// (architecture §14), wherever it is, except the defaults' models.jsonc (ADR 0153).
const recipes = readdirSync(root, { recursive: true, encoding: 'utf8' }).filter(
  (name) => name.endsWith('.jsonc') && name !== 'models.jsonc',
);

// Default recipes are language-independent (ADR 0023): their check steps name one of the five
// checks, never a literal command. That DefaultRecipe rejects a literal command, also inside a
// loop, is tested in recipe.test.ts.
describe('the recipes under defaults/', () => {
  if (recipes.length === 0) {
    it.todo('check the default recipes, once there are any');
  }
  for (const file of recipes) {
    it(`${file} is a default recipe, with named checks only`, () => {
      const result = readJsonc(readFileSync(join(root, file), 'utf8'), DefaultRecipe);
      assert.equal(result.valid, true, result.valid ? '' : result.reason);
    });
  }
});

describe('mash-in and the Innkeeper (ADR 0232)', () => {
  it("asks at its one step, through a read-only Innkeeper on builder, offering Foedrum's other recipes", () => {
    const loaded = loadRecipes(readBreweryFiles(join(root, '..', 'no-brewery')));
    assert.ok(loaded.valid, loaded.valid ? '' : loaded.problems.join('\n'));
    const mashIn = loaded.recipes.find('mash-in');
    assert.equal(mashIn?.firstStep, 'innkeep');
    assert.deepEqual(mashIn?.steps, ['innkeep']);
    assert.equal(mashIn?.choosesRecipe('innkeep'), true);
    const step = loaded.brewers.find('mash-in', 'innkeep');
    const { name, model, access, tools, output } = step?.brewer ?? {};
    assert.deepEqual(
      { name, model, access, allow: tools?.allow, schema: output?.schema },
      {
        name: 'innkeeper',
        model: 'builder',
        access: 'read',
        allow: ['Read', 'Grep', 'Glob', 'Edit(mash-in.md)'],
        schema: 'recipeChoice',
      },
    );
    assert.deepEqual(
      step?.choices?.map(({ name }) => name),
      ['deep-brew', 'deep-mash', 'mash', 'nip'],
    );
  });

  it('the Innkeeper offers deep-mash as the deep plan', () => {
    const text = readFileSync(join(root, 'brewers', 'innkeeper.md'), 'utf8');
    assert.match(text, /"version": 8,/);
    assert.match(text, /`deep-mash` for a deep one/);
  });

  it("the Innkeeper gets the Brewery's repositories as an input", () => {
    const loaded = loadRecipes(readBreweryFiles(join(root, '..', 'no-brewery')));
    assert.ok(loaded.valid, loaded.valid ? '' : loaded.problems.join('\n'));
    const inputs = loaded.brewers.find('mash-in', 'innkeep')?.brewer.inputs;
    assert.ok(
      inputs?.some(({ name, from }) => name === 'repositories' && from === 'repositories'),
      JSON.stringify(inputs),
    );
  });
});

describe('deep-mash (ADR 0372)', () => {
  const loaded = loadRecipes(readBreweryFiles(join(root, '..', 'no-brewery')));

  it('the default recipes hold deep-mash, of type mash', () => {
    assert.ok(loaded.valid, loaded.valid ? '' : loaded.problems.join('\n'));
    const files = readdirSync(join(root, 'recipes'));
    assert.ok(files.includes('deep-mash.jsonc'), files.join(', '));
    const deepMash = loaded.recipes.find('deep-mash');
    assert.equal(deepMash?.type, 'mash');
    assert.equal(deepMash?.children('taste')?.length, 7);
  });
});

describe("mash's Brewmaster and the Brewery's recipes (ADR 0234, ADR 0232)", () => {
  it('is given the recipes a sub-order may run with, those of type brew (ADR 0365)', () => {
    const loaded = loadRecipes(readBreweryFiles(join(root, '..', 'no-brewery')));
    assert.ok(loaded.valid, loaded.valid ? '' : loaded.problems.join('\n'));
    const step = loaded.brewers.find('mash', 'plan');
    assert.ok(
      step?.brewer.inputs.some(({ from }) => from === 'recipes'),
      'the Brewmaster names the recipes input',
    );
    assert.deepEqual(
      step?.choices?.map(({ name }) => name),
      ['deep-brew', 'nip'],
    );
  });
});

describe('the default plan lens (ADR 0312)', () => {
  it('a step after plan that names plan/naive-reader loads it from defaults/lenses/plan/', () => {
    const files = readBreweryFiles(join(root, '..', 'no-brewery'));
    const steps = [
      { id: 'plan', brewer: 'brewmaster' },
      {
        id: 'naive',
        brewer: 'taster',
        lens: 'plan/naive-reader',
        onFindings: { goto: 'plan', maxRounds: 1 },
      },
    ];
    const kettle = {
      name: 'kettle',
      type: 'mash',
      description: 'Plan, then read it.',
      testFirst: false,
      steps,
    };
    const loaded = loadRecipes({
      ...files,
      recipes: [{ path: 'recipes/kettle.jsonc', text: JSON.stringify(kettle) }],
    });
    assert.ok(loaded.valid, loaded.valid ? '' : loaded.problems.join('\n'));
    const lens = loaded.brewers.find('kettle', 'naive')?.lenses?.get('plan/naive-reader');
    assert.equal(lens?.path, 'defaults/lenses/plan/naive-reader.md');
  });
});

describe("the default recipes' Tasters, every finding routed (ADR 0354)", () => {
  const loaded = loadRecipes(readBreweryFiles(join(root, '..', 'no-brewery')));

  it('every default recipe loads', () => {
    assert.ok(loaded.valid, loaded.valid ? '' : loaded.problems.join('\n'));
  });

  for (const [name, children] of [
    ['mash', ['coverage', 'sizing', 'naive-reader']],
    [
      'deep-mash',
      [
        'coverage',
        'sizing',
        'naive-reader',
        'order-and-overlap',
        'testability',
        'recipe-fit',
        'security',
      ],
    ],
  ] as const) {
    it(`${name} sends every plan lens's findings back to the plan, twice at most in all`, () => {
      assert.ok(loaded.valid);
      const recipe = loaded.recipes.find(name);
      assert.deepEqual(recipe?.children('taste'), [...children]);
      for (const child of children) {
        assert.equal(recipe.routesTo(child, 'findings'), 'plan', child);
        assert.equal(recipe.maxRounds(child, 'findings'), 2, child);
      }
    });
  }

  it("nip's correctness runs again after every round back, its other Tasters only on findings (ADR 0357)", () => {
    assert.ok(loaded.valid);
    const nip = loaded.recipes.find('nip');
    const children = nip?.children('taste') ?? [];
    assert.deepEqual(
      children.filter((child) => nip?.everyRound(child)),
      ['correctness'],
    );
  });

  for (const name of ['mash', 'deep-mash']) {
    it(`${name}'s plan lenses run again only on findings, none every round (ADR 0357)`, () => {
      assert.ok(loaded.valid);
      const recipe = loaded.recipes.find(name);
      const children = recipe?.children('taste') ?? [];
      assert.ok(children.length > 0);
      assert.deepEqual(
        children.filter((child) => recipe?.everyRound(child)),
        [],
      );
    });
  }
});
