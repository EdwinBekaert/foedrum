// Reading the Brewery's recipe and brewer files (ADR 0053), the shell: a real folder under
// .foedrum/tmp/tests. What the files mean is in recipe-files.test.ts.

import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { breweryRecipes, readBreweryFiles } from '../../src/engine/brewery-files.ts';
import { INVALID_RECIPES, loadRecipes } from '../../src/engine/recipe-files.ts';
import { BrewerFrontmatter } from '../../src/schemas/brewer.ts';
import { ModelsConfig } from '../../src/schemas/models.ts';
import { readDoc, readJsonc } from '../../src/schemas/read.ts';
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
    write('lenses/diff/security.md', 'our security');
    write('foedrum/defaults/recipes/nip.jsonc', 'nip');
    write('foedrum/defaults/brewers/gauger.md', 'gauger');
    write('foedrum/defaults/lenses/diff/correctness.md', 'correctness');
    const files = readBreweryFiles(brewery.path, join(brewery.path, 'foedrum', 'defaults'));
    assert.deepEqual(files.lenses, [{ path: 'lenses/diff/security.md', text: 'our security' }]);
    assert.deepEqual(files.defaults, {
      recipes: [{ path: 'defaults/recipes/nip.jsonc', text: 'nip' }],
      brewers: [{ path: 'defaults/brewers/gauger.md', text: 'gauger' }],
      lenses: [{ path: 'defaults/lenses/diff/correctness.md', text: 'correctness' }],
    });
  });

  it("reads the defaults' models.jsonc by its path in defaults/, and has none where it is missing (ADR 0153)", () => {
    const defaults = join(brewery.path, 'foedrum', 'defaults');
    write('models.jsonc', "the Brewery's own, which is not read here");
    assert.equal(readBreweryFiles(brewery.path, defaults).defaults?.models, undefined);
    write('foedrum/defaults/models.jsonc', '{ "models": { "builder": "sonnet" } }');
    assert.deepEqual(readBreweryFiles(brewery.path, defaults).defaults?.models, {
      path: 'defaults/models.jsonc',
      text: '{ "models": { "builder": "sonnet" } }',
    });
  });

  it("has a defaults/models.jsonc in Foedrum's install that maps builder to the family sonnet (ADR 0153)", () => {
    const found = readBreweryFiles(brewery.path).defaults?.models;
    assert.ok(found !== undefined && 'text' in found, 'no defaults/models.jsonc was read');
    assert.equal(found.path, 'defaults/models.jsonc');
    const read = readJsonc(found.text, ModelsConfig);
    assert.ok(read.valid, read.valid ? '' : read.reason);
    assert.deepEqual(read.value.models, { builder: 'sonnet' });
    assert.deepEqual(read.value.brewers, {});
  });

  it('maps every alias that a default brewer names in its defaults/models.jsonc (ADR 0153)', () => {
    const { brewers = [], models } = readBreweryFiles(brewery.path).defaults ?? {};
    assert.ok(models !== undefined && 'text' in models, 'no defaults/models.jsonc was read');
    const mapped = readJsonc(models.text, ModelsConfig);
    assert.ok(mapped.valid, mapped.valid ? '' : mapped.reason);
    assert.ok(brewers.length > 0, 'no default brewers were read');
    for (const file of brewers) {
      assert.ok('text' in file, file.path);
      const doc = readDoc(file.text, BrewerFrontmatter);
      assert.ok(doc.valid, file.path);
      assert.ok(
        Object.hasOwn(mapped.value.models, doc.frontmatter.model),
        `${file.path} names the alias "${doc.frontmatter.model}", which defaults/models.jsonc does not map`,
      );
    }
  });

  it('reads the lenses of lenses/diff/ and lenses/plan/, and those directly in lenses/, which do not load (ADR 0143)', () => {
    write('lenses/stray.md', 'stray');
    write('lenses/diff/security.md', 'diff security');
    write('lenses/plan/coverage.md', 'plan coverage');
    write('lenses/plan/security.md', 'plan security');
    // Not lens files: another folder, one folder further down, another extension.
    write('lenses/code/style.md', 'style');
    write('lenses/diff/old/security.md', 'old');
    write('lenses/plan/notes.txt', 'notes');
    assert.deepEqual(readBreweryFiles(brewery.path).lenses, [
      { path: 'lenses/stray.md', text: 'stray' },
      { path: 'lenses/diff/security.md', text: 'diff security' },
      { path: 'lenses/plan/coverage.md', text: 'plan coverage' },
      { path: 'lenses/plan/security.md', text: 'plan security' },
    ]);
  });

  it('lists a lens folder it cannot read by its path (ADR 0143)', () => {
    write('lenses/plan', 'a file where the folder should be');
    const lenses = readBreweryFiles(brewery.path).lenses ?? [];
    assert.equal(lenses.length, 1);
    assert.equal(lenses[0]?.path, 'lenses/plan');
    assert.match(lenses[0] && 'unreadable' in lenses[0] ? lenses[0].unreadable : '', /ENOTDIR/);
  });

  it('lists a defaults folder it cannot read by its path in defaults/ (ADR 0098)', () => {
    write('foedrum/defaults/lenses', 'a file where the folder should be');
    const lenses = readBreweryFiles(brewery.path, join(brewery.path, 'foedrum', 'defaults'))
      .defaults?.lenses;
    assert.equal(lenses?.length, 1);
    assert.equal(lenses?.[0]?.path, 'defaults/lenses');
    assert.match(lenses?.[0] && 'unreadable' in lenses[0] ? lenses[0].unreadable : '', /ENOTDIR/);
  });

  it("lists the defaults' models.jsonc it cannot read by its path in defaults/ (ADR 0153)", () => {
    write('foedrum/defaults/models.jsonc/x', 'a folder where the file should be');
    const models = readBreweryFiles(brewery.path, join(brewery.path, 'foedrum', 'defaults'))
      .defaults?.models;
    assert.equal(models?.path, 'defaults/models.jsonc');
    assert.match(models && 'unreadable' in models ? models.unreadable : '', /EISDIR/);
  });

  it("reads the defaults of Foedrum's own install, wherever the Brewery is (ADR 0098)", () => {
    const lenses = readBreweryFiles(brewery.path).defaults?.lenses ?? [];
    const found = lenses.find(({ path }) => path === 'defaults/lenses/diff/test-design.md');
    assert.ok(found !== undefined, lenses.map(({ path }) => path).join(', '));
    const own = readFileSync(
      join(import.meta.dirname, '..', '..', 'defaults', 'lenses', 'diff', 'test-design.md'),
      'utf8',
    );
    assert.deepEqual(found, { path: 'defaults/lenses/diff/test-design.md', text: own });
  });

  it("has the five default lenses in Foedrum's defaults/lenses/diff/ (ADR 0022, ADR 0143)", () => {
    const lenses = readBreweryFiles(brewery.path).defaults?.lenses ?? [];
    assert.deepEqual(
      lenses.map(({ path }) => path),
      ['correctness', 'cross-platform', 'design-conformance', 'security', 'test-design'].map(
        (name) => `defaults/lenses/diff/${name}.md`,
      ),
    );
  });

  it('reads the defaults of the install, not of the working directory (ADR 0098)', () => {
    // A working directory with defaults of its own, which must not be read.
    write('defaults/lenses/diff/test-design.md', "the working directory's lens");
    const cwd = process.cwd();
    process.chdir(brewery.path);
    try {
      const lenses = readBreweryFiles(brewery.path).defaults?.lenses ?? [];
      const found = lenses.find(({ path }) => path === 'defaults/lenses/diff/test-design.md');
      assert.ok(found !== undefined && 'text' in found);
      assert.notEqual(found.text, "the working directory's lens");
    } finally {
      process.chdir(cwd);
    }
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
