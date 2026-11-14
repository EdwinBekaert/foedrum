// A brewer names a model level and an effort of Foedrum's own, which models.jsonc's `claude` block
// translates into the model and the effort `claude` runs with (ADR 0397). Pure: serveSetup over
// the files' text and Foedrum's defaults, no process starts (ADR 0021).

import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { effortOf, modelOf } from '../../src/brewers/attempt-plan.ts';
import { claudeArgs } from '../../src/brewers/claude-command.ts';
import { type ServeInputs, type ServeSetup, serveSetup } from '../../src/cli/serve-config.ts';
import { FOEDRUM_DEFAULTS, readBreweryFiles } from '../../src/engine/brewery-files.ts';
import type { BreweryFile } from '../../src/engine/recipe-files.ts';
import { BrewerFrontmatter } from '../../src/schemas/brewer.ts';
import { ModelsConfig } from '../../src/schemas/models.ts';
import { Recipe } from '../../src/schemas/recipe.ts';
import { testGuidance } from '../helpers/brewery-files.ts';
import { brewer as cellarman, recipe, serveInputs } from '../helpers/serve-brewery.ts';

/**
 * Every brewer step of the default recipes, its brewer, and the model and effort its `claude` line
 * had before the levels: no brewer changes model or how hard it thinks (#1058).
 */
const BEFORE: readonly (readonly [string, string, string, string])[] = [
  ['deep-brew/survey', 'maltster-survey', 'sonnet', 'medium'],
  ['deep-brew/map', 'maltster-map', 'haiku', 'medium'],
  ['deep-brew/gauge', 'gauger', 'sonnet', 'high'],
  ['deep-brew/implement', 'cellarman', 'sonnet', 'high'],
  ['deep-brew/fine', 'finer', 'sonnet', 'high'],
  ['deep-brew/mutants', 'brett', 'sonnet', 'medium'],
  ['deep-brew/taste', 'taster', 'opus', 'medium'],
  ['deep-mash/plan', 'brewmaster', 'opus', 'high'],
  ['deep-mash/coverage', 'taster', 'opus', 'medium'],
  ['deep-mash/sizing', 'taster', 'sonnet', 'medium'],
  ['deep-mash/naive-reader', 'taster', 'sonnet', 'medium'],
  ['deep-mash/order-and-overlap', 'taster', 'sonnet', 'medium'],
  ['deep-mash/testability', 'taster', 'sonnet', 'medium'],
  ['deep-mash/recipe-fit', 'taster', 'sonnet', 'medium'],
  ['deep-mash/security', 'taster', 'opus', 'medium'],
  ['deep-mash/lauter', 'brewmaster', 'opus', 'high'],
  ['mash-in/innkeep', 'innkeeper', 'sonnet', 'low'],
  ['mash/plan', 'brewmaster', 'opus', 'high'],
  ['mash/coverage', 'taster', 'opus', 'medium'],
  ['mash/sizing', 'taster', 'sonnet', 'medium'],
  ['mash/naive-reader', 'taster', 'sonnet', 'medium'],
  ['mash/lauter', 'brewmaster', 'opus', 'high'],
  ['nip/survey', 'maltster-survey', 'sonnet', 'medium'],
  ['nip/map', 'maltster-map', 'haiku', 'medium'],
  ['nip/gauge', 'gauger', 'sonnet', 'high'],
  ['nip/implement', 'cellarman', 'sonnet', 'high'],
  ['nip/fine', 'finer', 'sonnet', 'high'],
  ['nip/correctness', 'taster', 'sonnet', 'high'],
  ['nip/acceptance', 'taster', 'sonnet', 'high'],
  ['nip/security', 'taster', 'sonnet', 'high'],
  ['nip/design-conformance', 'taster', 'sonnet', 'medium'],
];

const SESSION = '0f8fad5b-d9cb-469f-a165-70867728950e';

const ready = (given: ServeInputs): ServeSetup => {
  const result = serveSetup(given);
  assert.equal(result.kind, 'ready', result.kind === 'refused' ? result.problems.join('\n') : '');
  return result.kind === 'ready' ? result.setup : assert.fail();
};
const refused = (given: ServeInputs): string[] => {
  const result = serveSetup(given);
  return result.kind === 'refused' ? result.problems : assert.fail('serve was not refused');
};

/** serve's inputs for a Brewery of Foedrum's defaults alone, `own` as its models.jsonc. */
const defaultsBrewery = (own: string | undefined): ServeInputs =>
  serveInputs({
    files: {
      ...serveInputs().files,
      models: own,
      brewery: readBreweryFiles(join(FOEDRUM_DEFAULTS, 'no-such-brewery')),
    },
  });

/** The `--model` and `--effort` of the `claude` line of `step` (`<recipe>/<step id>`). */
const lineOf = (
  setup: ServeSetup,
  step: string,
): { model: string | undefined; effort: string | undefined } => {
  const [name = '', stepId = ''] = step.split('/');
  const found = setup.brewers.find(name, stepId);
  assert.ok(found !== undefined, `no brewer step ${step}`);
  const args = claudeArgs({
    model: modelOf(setup.models, found.brewer),
    effort: effortOf(setup.models, found.brewer),
    settingsFile: 'settings.json',
    tools: ['Read'],
    session: { kind: 'new', id: SESSION },
  });
  const value = (option: string) => args[args.indexOf(option) + 1];
  return { model: value('--model'), effort: value('--effort') };
};

describe('model levels and efforts of Foedrum’s own (#1058, ADR 0397)', () => {
  it('each default brewer step runs on the same claude --model and --effort as before the levels', () => {
    const setup = ready(defaultsBrewery(undefined));
    for (const [step, name, model, effort] of BEFORE) {
      const [recipeName = '', stepId = ''] = step.split('/');
      assert.equal(setup.brewers.find(recipeName, stepId)?.brewer.name, name, step);
      assert.deepEqual(lineOf(setup, step), { model, effort }, step);
    }
  });

  it("a Brewery's models.jsonc that maps careful to xhigh passes --effort xhigh to every careful step and changes nothing else", () => {
    const own = JSON.stringify({ claude: { efforts: { careful: 'xhigh' } } });
    const setup = ready(defaultsBrewery(own));
    for (const [step, , model, effort] of BEFORE) {
      const moved = effort === 'high' ? 'xhigh' : effort;
      assert.deepEqual(lineOf(setup, step), { model, effort: moved }, step);
    }
  });

  it('a brewer whose effort has no translation refuses the start with a line naming the brewer', () => {
    const problems = refused(
      gaugerBrewery({ efforts: { quick: 'low', steady: 'medium' } }, { effort: 'careful' }),
    );
    assert.deepEqual(problems, [
      'defaults/brewers/gauger.md: models.jsonc has no claude effort for the effort "careful" of the brewer "gauger"',
    ]);
  });

  it("a step whose effort override has no translation refuses the start with a line naming the step's brewer", () => {
    const steps = [
      { id: 'brew', brewer: 'gauger', effort: 'thorough' },
      { action: 'openPullRequest' },
    ];
    const problems = refused(gaugerBrewery({}, {}, steps));
    assert.deepEqual(problems, [
      'recipes/stout.jsonc: step "brew" of the brewer "gauger" names the effort "thorough", which models.jsonc has no claude effort for',
    ]);
  });

  it('a brewer whose level and effort both have no translation refuses the start with a line for each', () => {
    const problems = refused(
      gaugerBrewery(
        { models: { light: 'haiku' }, efforts: { quick: 'low' } },
        { model: 'strong', effort: 'careful' },
      ),
    );
    assert.deepEqual(problems, [
      'defaults/brewers/gauger.md: models.jsonc has no claude model for the level "strong" of the brewer "gauger"',
      'defaults/brewers/gauger.md: models.jsonc has no claude effort for the effort "careful" of the brewer "gauger"',
    ]);
  });

  it('a step whose level and effort overrides both have no translation refuses the start with a line for each', () => {
    const steps = [
      { id: 'brew', brewer: 'gauger', model: 'strong', effort: 'thorough' },
      { action: 'openPullRequest' },
    ];
    const problems = refused(gaugerBrewery({ models: { standard: 'sonnet' } }, {}, steps));
    assert.deepEqual(problems, [
      'recipes/stout.jsonc: step "brew" of the brewer "gauger" names the level "strong", which models.jsonc has no claude model for',
      'recipes/stout.jsonc: step "brew" of the brewer "gauger" names the effort "thorough", which models.jsonc has no claude effort for',
    ]);
  });

  it('a level with no model refuses the start, as an alias with no model did', () => {
    const problems = refused(gaugerBrewery({ models: { light: 'haiku' } }, { model: 'strong' }));
    assert.deepEqual(problems, [
      'defaults/brewers/gauger.md: models.jsonc has no claude model for the level "strong" of the brewer "gauger"',
    ]);
  });

  it("a step's effort override takes Foedrum's level and refuses a Claude Code word", () => {
    const stout = (effort: string) => ({
      name: 'stout',
      type: 'brew',
      description: 'Brews an order in one step.',
      guidance: testGuidance,
      testFirst: false,
      steps: [{ id: 'brew', brewer: 'cellarman', effort }, { action: 'openPullRequest' }],
    });
    for (const level of ['quick', 'steady', 'careful', 'thorough']) {
      assert.equal(Recipe.safeParse(stout(level)).success, true, level);
    }
    for (const word of ['low', 'medium', 'high', 'xhigh', 'max']) {
      assert.equal(Recipe.safeParse(stout(word)).success, false, word);
    }
  });

  it("a brewer names one of the three levels and one of Foedrum's four efforts, never an alias or a Claude Code word", () => {
    const frontmatter = (fields: Record<string, string>) => {
      const text = cellarman.replace('"model": "light"', `"model": "${fields.model ?? 'light'}"`);
      const json = text.split('---')[1] ?? '';
      return { ...JSON.parse(json), ...fields };
    };
    for (const model of ['light', 'standard', 'strong']) {
      assert.equal(BrewerFrontmatter.safeParse(frontmatter({ model })).success, true, model);
    }
    for (const effort of ['quick', 'steady', 'careful', 'thorough']) {
      assert.equal(BrewerFrontmatter.safeParse(frontmatter({ effort })).success, true, effort);
    }
    for (const model of ['builder', 'planner', 'explorer', 'sonnet']) {
      assert.equal(BrewerFrontmatter.safeParse(frontmatter({ model })).success, false, model);
    }
    for (const effort of ['low', 'medium', 'high']) {
      assert.equal(BrewerFrontmatter.safeParse(frontmatter({ effort })).success, false, effort);
    }
  });

  it("models.jsonc holds a claude block of models by level and efforts by Foedrum's effort, each a Claude Code word", () => {
    const accepted = (value: unknown) => ModelsConfig.safeParse(value).success;
    assert.equal(
      accepted({
        claude: {
          models: { light: 'haiku', standard: 'claude-sonnet-5-5', strong: 'opus' },
          efforts: { quick: 'low', steady: 'medium', careful: 'high', thorough: 'max' },
        },
        brewers: { taster: 'strong' },
      }),
      true,
    );
    assert.equal(accepted({ claude: { efforts: { careful: 'xhigh' } } }), true);
    assert.equal(accepted({ models: { builder: 'sonnet' } }), false, 'an alias outside claude');
    assert.equal(accepted({ claude: { models: { builder: 'sonnet' } } }), false, 'an alias');
    assert.equal(
      accepted({ claude: { efforts: { high: 'high' } } }),
      false,
      'a Claude word as key',
    );
    assert.equal(accepted({ claude: { efforts: { careful: 'hard' } } }), false, 'an unknown word');
    assert.equal(
      accepted({ claude: { models: { strong: 'opus' } }, brewers: { taster: 'opus' } }),
      false,
      'a swap to a model, not a level',
    );
  });
});

/** The Gauger's defaults/brewers file naming `model` and `effort`, brewing recipe stout's one step. */
function gaugerBrewery(
  claude: Record<string, unknown>,
  gauger: { model?: string; effort?: string },
  steps?: readonly unknown[],
): ServeInputs {
  const { model = 'standard', effort = 'steady' } = gauger;
  const text = cellarman
    .replace('"name": "cellarman"', '"name": "gauger"')
    .replace('"model": "light"', `"model": "${model}"`)
    .replace('"effort": "quick"', `"effort": "${effort}"`);
  const stout =
    steps === undefined
      ? recipe.replace('cellarman', 'gauger')
      : JSON.stringify({ ...JSON.parse(recipe), steps });
  const defaults: BreweryFile = {
    path: 'defaults/models.jsonc',
    text: JSON.stringify({
      claude: {
        models: { light: 'haiku', standard: 'sonnet', strong: 'opus' },
        efforts: { quick: 'low', steady: 'medium' },
        ...claude,
      },
    }),
  };
  return serveInputs({
    files: {
      ...serveInputs().files,
      models: undefined,
      brewery: {
        recipes: [{ path: 'recipes/stout.jsonc', text: stout }],
        brewers: [],
        defaults: { brewers: [{ path: 'defaults/brewers/gauger.md', text }], models: defaults },
      },
    },
  });
}
