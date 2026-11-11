// A recipe's guidance (ADR 0375): what it does is its description; when to choose it, when not,
// and how it is best used are its guidance, which every recipe offered as a choice carries and
// the models that choose a recipe read in their recipes input. Pure: no process starts.

import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { inputsOf } from '../../src/brewers/attempt-plan.ts';
import { readBreweryFiles } from '../../src/engine/brewery-files.ts';
import { fold } from '../../src/engine/fold.ts';
import {
  type BreweryFile,
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

const problemsOf = (files: BreweryFiles): readonly string[] => {
  const result = loadRecipes(files);
  assert.ok(!result.valid, 'the files should not load');
  return result.problems;
};

const stoutGuidance = {
  chooseWhen: 'An order for a stout, poured in one repository',
  notWhen: 'An order for a lager',
  bestUsed: 'With the stout named in the order',
};

/** A Brewery recipe that builds, written out in full; `fields` change it. */
const stout = (fields: Record<string, unknown> = {}): BreweryFile => ({
  path: 'recipes/stout.jsonc',
  text: JSON.stringify({
    name: 'stout',
    type: 'brew',
    description: 'Brews a stout in one step and opens its pull request.',
    guidance: stoutGuidance,
    steps: [{ id: 'brew', brewer: 'cellarman' }, { action: 'openPullRequest' }],
    testFirst: false,
    ...fields,
  }),
});

/** The recipes input the Innkeeper's step gets, from the loaded recipes. */
const innkeeperRecipes = (loaded: Extract<LoadedRecipes, { valid: true }>): string => {
  const step = loaded.brewers.find('mash-in', 'innkeep') ?? assert.fail('mash-in has no innkeep');
  const batch = fold([
    {
      type: 'batch.ordered',
      batchId: '12-1',
      order: { issue: 12 },
      routeBy: '2026-11-11T12:00:00.000Z',
    },
  ]).batches.get('12-1');
  assert.ok(batch !== undefined);
  const inputs = inputsOf(
    step.brewer.inputs,
    batch,
    () => undefined,
    'worktree',
    new Map(),
    { repositories: [{ repo: 'acme/web', base: 'main' }], own: 'acme/web' },
    step.choices,
  );
  const recipes = inputs.find(({ name }) => name === 'recipes');
  assert.ok(recipes?.read.kind === 'text', JSON.stringify(recipes));
  return recipes.read.text;
};

describe("a default recipe's guidance (ADR 0375)", () => {
  it('every default recipe states what it does, when to choose it and how it is best used', () => {
    const loaded = valid(loadRecipes(defaults()));
    const offered = loaded.brewers.find('mash-in', 'innkeep')?.choices ?? [];
    assert.deepEqual(
      offered.map(({ name }) => name),
      ['deep-brew', 'deep-mash', 'mash', 'nip'],
    );
    for (const { name, description, guidance } of offered) {
      assert.match(description, /\S/, name);
      assert.ok(guidance !== undefined, `${name} has no guidance`);
      for (const [field, text] of Object.entries(guidance)) {
        assert.match(text, /\S{3}/, `${name}: ${field}`);
      }
      assert.deepEqual(Object.keys(guidance).sort(), ['bestUsed', 'chooseWhen', 'notWhen'], name);
    }
  });

  it("nip's guidance says it is not for a change that can reach a lot, however small", () => {
    const loaded = valid(loadRecipes(defaults()));
    const nip = loaded.brewers.find('mash-in', 'innkeep')?.choices?.find((c) => c.name === 'nip');
    const notWhen = nip?.guidance?.notWhen ?? assert.fail('nip has no guidance');
    assert.match(notWhen, /can reach a lot/);
    assert.match(notWhen, /however small/);
    assert.match(notWhen, /deep-brew/);
  });
});

describe("the recipes input carries each recipe's guidance (ADR 0375)", () => {
  it("a recipe's guidance reaches the Innkeeper's recipes input", () => {
    const loaded = valid(loadRecipes({ ...defaults(), recipes: [stout()] }));
    const text = innkeeperRecipes(loaded);
    assert.match(
      text,
      /^- stout \(brew\): Brews a stout in one step and opens its pull request\.\n {2}Choose when: An order for a stout, poured in one repository\n {2}Not when: An order for a lager\n {2}Best used: With the stout named in the order\n/m,
    );
    // Every recipe offered gets its three lines, nip's among them.
    assert.equal(text.match(/^ {2}Not when: /gm)?.length, 5, text);
  });
});

describe('a Brewery recipe and its guidance (ADR 0375)', () => {
  it('a Brewery recipe offered without guidance is refused, and the line names the fix', () => {
    const problems = problemsOf({ ...defaults(), recipes: [stout({ guidance: undefined })] });
    assert.equal(problems.length, 1, problems.join('\n'));
    assert.match(
      problems[0] ?? '',
      /^recipes\/stout\.jsonc: the recipe stout is offered as a choice, so it needs "guidance": add "guidance": \{ "chooseWhen": .*, "notWhen": .*, "bestUsed": .* \}/,
    );
  });

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

  it('loads a Brewery recipe with guidance and offers it with that guidance', () => {
    const loaded = valid(loadRecipes({ ...defaults(), recipes: [stout()] }));
    const offered = loaded.brewers.find('mash-in', 'innkeep')?.choices ?? [];
    assert.deepEqual(offered.find(({ name }) => name === 'stout')?.guidance, stoutGuidance);
  });

  for (const field of ['chooseWhen', 'notWhen', 'bestUsed'] as const) {
    it(`refuses guidance without ${field}, naming it`, () => {
      const { [field]: _, ...rest } = stoutGuidance;
      const problems = problemsOf({ ...defaults(), recipes: [stout({ guidance: rest })] });
      assert.match(
        problems.join('\n'),
        new RegExp(`^recipes/stout\\.jsonc: ✖ .* → at guidance\\.${field}$`, 'm'),
      );
    });
  }

  it('refuses an empty guidance line, naming it', () => {
    const guidance = { ...stoutGuidance, notWhen: '  ' };
    const problems = problemsOf({ ...defaults(), recipes: [stout({ guidance })] });
    assert.match(
      problems.join('\n'),
      /^recipes\/stout\.jsonc: ✖ Must not be empty → at guidance\.notWhen$/m,
    );
  });

  const breaks: [string, string][] = [
    ['a line feed', '\n'],
    ['a carriage return', '\r'],
    ['a line separator', String.fromCodePoint(0x2028)],
    ['a paragraph separator', String.fromCodePoint(0x2029)],
  ];
  for (const [what, character] of breaks) {
    it(`refuses a guidance line with ${what}, which would forge a line of the input`, () => {
      const guidance = { ...stoutGuidance, chooseWhen: `A stout${character}- lager (brew): x` };
      const problems = problemsOf({ ...defaults(), recipes: [stout({ guidance })] });
      assert.match(
        problems.join('\n'),
        /^recipes\/stout\.jsonc: ✖ Must be one line → at guidance\.chooseWhen$/m,
      );
    });
  }

  it('takes a guidance line of 300 characters and refuses one of 301', () => {
    const line = (length: number) => ({ ...stoutGuidance, bestUsed: 'a'.repeat(length) });
    valid(loadRecipes({ ...defaults(), recipes: [stout({ guidance: line(300) })] }));
    const problems = problemsOf({ ...defaults(), recipes: [stout({ guidance: line(301) })] });
    assert.match(
      problems.join('\n'),
      /^recipes\/stout\.jsonc: ✖ .*300.* → at guidance\.bestUsed$/m,
    );
  });
});
