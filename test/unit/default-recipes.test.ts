import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { readJsonc } from '../../src/schemas/read.ts';
import { DefaultRecipe } from '../../src/schemas/recipe.ts';

const dir = join(import.meta.dirname, '..', '..', 'defaults', 'recipes');
const files = existsSync(dir) ? readdirSync(dir).filter((name) => name.endsWith('.jsonc')) : [];

// Default recipes are language-independent (ADR 0023): their check steps name one of the five
// checks, never a literal command. That DefaultRecipe rejects a literal command, also inside a
// loop, is tested in recipe.test.ts.
describe('the recipes under defaults/recipes/', () => {
  for (const file of files) {
    it(`${file} is a default recipe, with named checks only`, () => {
      const result = readJsonc(readFileSync(join(dir, file), 'utf8'), DefaultRecipe);
      assert.equal(result.valid, true, result.valid ? '' : result.reason);
    });
  }

  it('are all JSONC files', () => {
    const other = existsSync(dir)
      ? readdirSync(dir).filter((name) => !name.endsWith('.jsonc'))
      : [];
    assert.deepEqual(other, []);
  });
});
