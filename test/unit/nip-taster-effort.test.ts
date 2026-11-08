// Nip's correctness, acceptance and security Tasters run at high effort, and without the default
// Taster's read of the instruction file; design conformance asks for the rules through its lens
// (#935, ADR 0352). A step's effort overrides its brewer's as its model does (ADR 0321). Planned
// with createAttemptPlans, no process starts (ADR 0021).

import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { FOEDRUM_DEFAULTS, readBreweryFiles } from '../../src/engine/brewery-files.ts';
import { type LoadedRecipes, loadRecipes } from '../../src/engine/recipe-files.ts';

const noFiles = readBreweryFiles(join(FOEDRUM_DEFAULTS, 'no-such-brewery'));

const valid = (result: LoadedRecipes) => {
  assert.ok(result.valid, result.valid ? '' : result.problems.join('\n'));
  return result;
};

/** Nip's three Tasters that run at high effort (ADR 0352). */
const HIGH = new Set(['nip/correctness', 'nip/acceptance', 'nip/security']);

describe("the default recipes' Taster steps (#935)", () => {
  it("every Taster step of the default recipes but nip's three keeps its brewer's medium effort: regression test", () => {
    const { recipes, brewers } = valid(loadRecipes(noFiles));
    const others: string[] = [];
    for (const name of ['nip', 'mash', 'decoction', 'mash-in']) {
      for (const stepId of recipes.find(name)?.steps ?? []) {
        const found = brewers.find(name, stepId);
        if (found?.brewer.output.schema !== 'tasting') continue;
        if (HIGH.has(`${name}/${stepId}`)) continue;
        others.push(`${name}/${stepId}`);
        assert.equal(found.brewer.effort, 'medium', `${name}/${stepId}`);
      }
    }
    // The plan Tasters of mash and decoction, and nip's design conformance, are among them.
    assert.ok(others.includes('nip/design-conformance'), others.join(', '));
    assert.ok(others.includes('mash/coverage'), others.join(', '));
    assert.ok(others.includes('decoction/security'), others.join(', '));
  });
});
