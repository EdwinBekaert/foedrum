// Reading the Brewery's recipe and brewer files (ADR 0053), the shell: a real folder under
// .foedrum/tmp/tests. What the files mean is in recipe-files.test.ts.

import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { breweryRecipes, readBreweryFiles } from '../../src/engine/brewery-files.ts';
import { INVALID_RECIPES, loadRecipes } from '../../src/engine/recipe-files.ts';
import { brewerText, recipeText } from '../helpers/brewery-files.ts';
import { makeTempDir, type TempDir } from '../helpers/temp-dir.ts';

describe('readBreweryFiles', () => {
  let brewery: TempDir;
  beforeEach(() => {
    brewery = makeTempDir('brewery-files');
  });
  afterEach(() => brewery.remove());

  const write = (path: string, text: string): void => {
    const file = join(brewery.path, ...path.split('/'));
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(file, text);
  };

  it('has no files in a Brewery without recipe, brewer and lens folders, nor defaults without them', () => {
    const none = { recipes: [], brewers: [], lenses: [] };
    assert.deepEqual(readBreweryFiles(brewery.path, join(brewery.path, 'defaults')), {
      ...none,
      defaults: none,
    });
  });

  it("reads the Brewery's lenses, and the defaults' recipes, brewers and lenses by their path in defaults/ (ADR 0098)", () => {
    write('lenses/security.md', 'our security');
    write('foedrum/defaults/recipes/nip.jsonc', 'nip');
    write('foedrum/defaults/brewers/gauger.md', 'gauger');
    write('foedrum/defaults/lenses/correctness.md', 'correctness');
    const files = readBreweryFiles(brewery.path, join(brewery.path, 'foedrum', 'defaults'));
    assert.deepEqual(files.lenses, [{ path: 'lenses/security.md', text: 'our security' }]);
    assert.deepEqual(files.defaults, {
      recipes: [{ path: 'defaults/recipes/nip.jsonc', text: 'nip' }],
      brewers: [{ path: 'defaults/brewers/gauger.md', text: 'gauger' }],
      lenses: [{ path: 'defaults/lenses/correctness.md', text: 'correctness' }],
    });
  });

  it('lists a defaults folder it cannot read by its path in defaults/ (ADR 0098)', () => {
    write('foedrum/defaults/lenses', 'a file where the folder should be');
    const lenses = readBreweryFiles(brewery.path, join(brewery.path, 'foedrum', 'defaults'))
      .defaults?.lenses;
    assert.equal(lenses?.length, 1);
    assert.equal(lenses?.[0]?.path, 'defaults/lenses');
    assert.match(lenses?.[0] && 'unreadable' in lenses[0] ? lenses[0].unreadable : '', /ENOTDIR/);
  });

  it("reads the defaults of Foedrum's own install, wherever the Brewery is (ADR 0098)", () => {
    const lenses = readBreweryFiles(brewery.path).defaults?.lenses ?? [];
    const own = readFileSync(
      join(import.meta.dirname, '..', '..', 'defaults', 'lenses', 'test-design.md'),
      'utf8',
    );
    assert.deepEqual(
      lenses.find(({ path }) => path === 'defaults/lenses/test-design.md'),
      { path: 'defaults/lenses/test-design.md', text: own },
    );
  });

  it('reads the recipe and brewer files directly in their folders, by name', () => {
    write('recipes/pale.jsonc', 'pale');
    write('recipes/amber.jsonc', 'amber');
    write('brewers/maltster.md', 'maltster');
    // Not recipe or brewer files: another extension, or a file one folder down.
    write('recipes/README.md', 'notes');
    write('brewers/notes.txt', 'notes');
    write('recipes/old/stout.jsonc', 'stout');
    write('brewers/old/gauger.md', 'gauger');
    const { recipes, brewers } = readBreweryFiles(brewery.path);
    assert.deepEqual(
      { recipes, brewers },
      {
        recipes: [
          { path: 'recipes/amber.jsonc', text: 'amber' },
          { path: 'recipes/pale.jsonc', text: 'pale' },
        ],
        brewers: [{ path: 'brewers/maltster.md', text: 'maltster' }],
      },
    );
  });

  it('lists a recipe file it cannot read with the reason', () => {
    mkdirSync(join(brewery.path, 'recipes', 'pale.jsonc'), { recursive: true });
    const { recipes } = readBreweryFiles(brewery.path);
    assert.equal(recipes.length, 1);
    assert.equal(recipes[0]?.path, 'recipes/pale.jsonc');
    assert.match(recipes[0] && 'unreadable' in recipes[0] ? recipes[0].unreadable : '', /EISDIR/);
  });

  it('lists a recipe folder it cannot read with the reason', () => {
    write('recipes', 'a file where the folder should be');
    const { recipes } = readBreweryFiles(brewery.path);
    assert.equal(recipes.length, 1);
    assert.equal(recipes[0]?.path, 'recipes');
    assert.match(recipes[0] && 'unreadable' in recipes[0] ? recipes[0].unreadable : '', /ENOTDIR/);
  });
});

describe('breweryRecipes', () => {
  let brewery: TempDir;
  beforeEach(() => {
    brewery = makeTempDir('brewery-recipes');
  });
  afterEach(() => brewery.remove());

  const write = (folder: string, file: string, text: string): void => {
    mkdirSync(join(brewery.path, folder), { recursive: true });
    writeFileSync(join(brewery.path, folder, file), text);
  };

  it("loads the Brewery's recipes", () => {
    write('brewers', 'maltster.md', brewerText('maltster'));
    write('recipes', 'pale.jsonc', recipeText('pale', [{ brewer: 'maltster' }]));
    assert.equal(breweryRecipes(brewery.path).find('pale')?.firstStep, 'maltster');
  });

  it("loads Foedrum's own defaults in a Brewery without files of its own (ADR 0098)", () => {
    const loaded = loadRecipes(readBreweryFiles(brewery.path));
    assert.equal(loaded.valid, true, loaded.valid ? '' : loaded.problems.join('\n'));
  });

  it("throws doctor's line when a file is not valid", () => {
    write('recipes', 'pale.jsonc', recipeText('pale', [{ brewer: 'maltster' }]));
    assert.throws(() => breweryRecipes(brewery.path), {
      message: `${INVALID_RECIPES}: recipes/pale.jsonc: it names no brewer "maltster" that the Brewery's brewers/ or Foedrum's defaults have (ADR 0098)`,
    });
  });
});
