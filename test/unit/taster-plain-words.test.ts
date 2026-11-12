// A Taster's finding starts with one plain sentence a person reads, and only then its file, line
// and rule (ADR 0386). Read from the default recipes as loaded, no process starts (ADR 0021).

import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { FOEDRUM_DEFAULTS, readBreweryFiles } from '../../src/engine/brewery-files.ts';
import { loadRecipes } from '../../src/engine/recipe-files.ts';

const noFiles = readBreweryFiles(join(FOEDRUM_DEFAULTS, 'no-such-brewery'));

describe("the default Taster's findings (ADR 0386)", () => {
  it('the taster prompt asks for a plain sentence before the file and rule', () => {
    const loaded = loadRecipes(noFiles);
    assert.ok(loaded.valid, loaded.valid ? '' : loaded.problems.join('\n'));
    // A diff lens's step and a plan lens's step.
    for (const [recipe, stepId] of [
      ['nip', 'correctness'],
      ['mash', 'coverage'],
    ] as const) {
      const found = loaded.brewers.find(recipe, stepId);
      assert.equal(found?.brewer.output.schema, 'tasting', `${recipe}/${stepId}`);
      const { instructions = '' } = found ?? {};
      assert.match(
        instructions,
        /its first sentence \(on a plan, after the sub-order's id\) says what is wrong, why it matters and what to do, with no file, line, rule id or ADR number in it/,
      );
      assert.match(instructions, /name the rule's id after the first sentence/);
      assert.doesNotMatch(
        instructions,
        /start the `why` of a finding that breaks one with the rule's id/,
      );
    }
  });
});
