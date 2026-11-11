// A recipe's guidance (ADR 0375): what it does is its description; when to choose it, when not,
// and how it is best used are its guidance, which every recipe offered as a choice carries and
// the models that choose a recipe read in their recipes input. Pure: no process starts.

import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { readBreweryFiles } from '../../src/engine/brewery-files.ts';
import {
  type BreweryFiles,
  type LoadedRecipes,
  loadRecipes,
} from '../../src/engine/recipe-files.ts';

// The defaults under a Brewery with no files of its own.
const defaults = (): BreweryFiles =>
  readBreweryFiles(join(import.meta.dirname, '..', '..', 'no-brewery'));

const valid = (result: LoadedRecipes): Extract<LoadedRecipes, { valid: true }> => {
  assert.ok(result.valid, result.valid ? '' : result.problems.join('\n'));
  return result;
};

describe('a Brewery recipe and its guidance (ADR 0375)', () => {
  it('loads a Brewery recipe that chooses a recipe without guidance, since it is never offered (regression test)', () => {
    const ask = {
      path: 'recipes/ask.jsonc',
      text: JSON.stringify({
        name: 'ask',
        type: 'mash',
        description: 'Asks which recipe brews the order.',
        steps: [{ id: 'innkeep', brewer: 'innkeeper', chooses: 'recipe' }],
      }),
    };
    const loaded = valid(loadRecipes({ ...defaults(), recipes: [ask] }));
    assert.ok(loaded.recipes.find('ask') !== undefined);
  });
});
