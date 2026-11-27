// A house-yeast rule was learned from earlier reviews and can be wrong or out of date, so the
// default Taster reports the rule itself as a finding, with its id, instead of holding a change
// to it (#1162, ADR 0437). Read from the default recipes as loaded, no process starts (ADR 0021).

import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { FOEDRUM_DEFAULTS, readBreweryFiles } from '../../src/engine/brewery-files.ts';
import { loadRecipes } from '../../src/engine/recipe-files.ts';

const noFiles = readBreweryFiles(join(FOEDRUM_DEFAULTS, 'no-such-brewery'));

describe("the default Taster's house rules (#1162, ADR 0437)", () => {
  const loaded = () => {
    const recipes = loadRecipes(noFiles);
    assert.ok(recipes.valid, recipes.valid ? '' : recipes.problems.join('\n'));
    return recipes;
  };
  // A diff lens's step and a plan lens's step.
  const steps = [
    ['nip', 'correctness'],
    ['mash', 'coverage'],
  ] as const;

  it('says a rule was learned from earlier reviews and can be wrong or out of date', () => {
    for (const [recipe, stepId] of steps) {
      const { instructions = '' } = loaded().brewers.find(recipe, stepId) ?? {};
      assert.match(instructions, /learned from earlier reviews/, `${recipe}/${stepId}`);
      assert.match(instructions, /can be wrong or out of date/, `${recipe}/${stepId}`);
    }
  });

  it('asks for the rule itself as a finding, with its id, when following it would make the change worse', () => {
    for (const [recipe, stepId] of steps) {
      const { instructions = '' } = loaded().brewers.find(recipe, stepId) ?? {};
      assert.match(instructions, /would make (?:this|the) change worse/, `${recipe}/${stepId}`);
      assert.match(
        instructions,
        /report the rule itself as a finding[^\n]*\bid\b/i,
        `${recipe}/${stepId}`,
      );
      assert.match(
        instructions,
        /(?:instead of|rather than) holding the change to (?:it|the rule)/,
        `${recipe}/${stepId}`,
      );
    }
  });

  it('asks for the rule itself as a finding when the change deliberately alters what the rule describes', () => {
    for (const [recipe, stepId] of steps) {
      const { instructions = '' } = loaded().brewers.find(recipe, stepId) ?? {};
      assert.match(
        instructions,
        /deliberately (?:alters|changes) what (?:a|the) rule describes/,
        `${recipe}/${stepId}`,
      );
    }
  });

  it('raises the version of the default Taster, whose prompt changed', () => {
    const found = loaded().brewers.find('nip', 'correctness');
    assert.equal(found?.brewer.name, 'taster');
    assert.ok((found?.brewer.version ?? 0) > 13, String(found?.brewer.version));
  });

  it("still asks for the id of a rule a finding breaks after the finding's first sentence (regression test, #1162)", () => {
    for (const [recipe, stepId] of steps) {
      const { instructions = '' } = loaded().brewers.find(recipe, stepId) ?? {};
      assert.match(instructions, /name the rule's id after the first sentence/);
      assert.match(
        instructions,
        /with no file, line, rule id or ADR number in it/,
        `${recipe}/${stepId}`,
      );
    }
  });
});
