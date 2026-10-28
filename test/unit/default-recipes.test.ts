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
      ['nip'],
    );
  });
});
