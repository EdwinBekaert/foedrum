import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { type Brewers, resolveRecipe } from '../../src/engine/resolve-recipe.ts';
import { Recipe } from '../../src/schemas/recipe.ts';

const brewers: Brewers = (name) =>
  (
    ({
      brewmaster: { produces: 'report' },
      cellarman: { produces: 'commits' },
      taster: { produces: 'report' },
      scribe: { produces: 'comment' },
    }) as const
  )[name];

const recipe = (steps: unknown[], testFirst?: boolean) =>
  Recipe.parse({
    name: 'test-recipe',
    description: 'A recipe for tests',
    steps,
    ...(testFirst === undefined ? {} : { testFirst }),
  });

const plan = { id: 'plan', brewer: 'brewmaster' };
const implement = { id: 'implement', brewer: 'cellarman' };
const review = {
  id: 'review',
  loop: {
    maxRounds: 2,
    until: "tasting.verdict == 'approve'",
    steps: [
      { id: 'tasting', parallel: [{ id: 'correctness', brewer: 'taster', lens: 'correctness' }] },
      { id: 'fix', brewer: 'cellarman' },
    ],
  },
};

// ADR 0017: test-first by default for recipes that write code; the schema leaves it unset.
describe('resolveRecipe', () => {
  it('turns testFirst on when it is unset and a brewer produces commits', () => {
    assert.equal(resolveRecipe(recipe([plan, implement]), brewers).testFirst, true);
  });

  it('finds a brewer that produces commits inside a loop', () => {
    assert.equal(resolveRecipe(recipe([plan, review]), brewers).testFirst, true);
  });

  it('turns testFirst off when it is unset and no brewer produces commits', () => {
    const steps = [plan, { id: 'tasting', parallel: [{ brewer: 'taster', lens: 'security' }] }];
    assert.equal(resolveRecipe(recipe(steps), brewers).testFirst, false);
  });

  it('keeps an explicit value', () => {
    assert.equal(resolveRecipe(recipe([plan, implement], false), brewers).testFirst, false);
    assert.equal(resolveRecipe(recipe([plan], true), brewers).testFirst, true);
  });

  it('keeps the rest of the recipe', () => {
    const file = recipe([plan, implement]);
    assert.deepStrictEqual(resolveRecipe(file, brewers), { ...file, testFirst: true });
  });

  it("counts a session step's fallback brewer", () => {
    const refine = { id: 'refine', session: 'refine', deadline: '1h', fallback: 'cellarman' };
    assert.equal(resolveRecipe(recipe([refine]), brewers).testFirst, true);
  });

  it('refuses a recipe that names a brewer the Brewery does not have', () => {
    assert.throws(
      () => resolveRecipe(recipe([plan, { brewer: 'gauger' }]), brewers),
      /no brewer "gauger"/,
    );
  });
});
