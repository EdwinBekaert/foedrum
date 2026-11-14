// Nip's correctness, acceptance and security Tasters run at high effort, and without the default
// Taster's read of the instruction file; design conformance asks for the rules through its lens
// (#935, ADR 0352). A step's effort overrides its brewer's as its model does (ADR 0321). Planned
// with createAttemptPlans, no process starts (ADR 0021).

import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { createAttemptPlans } from '../../src/brewers/attempt-plans.ts';
import { FOEDRUM_DEFAULTS, readBreweryFiles } from '../../src/engine/brewery-files.ts';
import { fold } from '../../src/engine/fold.ts';
import {
  type BreweryFiles,
  type LoadedRecipes,
  loadRecipes,
} from '../../src/engine/recipe-files.ts';
import type { Event } from '../../src/schemas/events.ts';
import type { ModelsConfig } from '../../src/schemas/models.ts';
import { recipeText } from '../helpers/brewery-files.ts';
import { CLAUDE_EFFORTS, claudeModels } from '../helpers/models.ts';

const noFiles = readBreweryFiles(join(FOEDRUM_DEFAULTS, 'no-such-brewery'));

const valid = (result: LoadedRecipes) => {
  assert.ok(result.valid, result.valid ? '' : result.problems.join('\n'));
  return result;
};

/** Nip's three Tasters that run at high effort (ADR 0352). */
const HIGH = new Set(['nip/correctness', 'nip/acceptance', 'nip/security']);

describe("the default recipes' Taster steps (#935)", () => {
  it("every Taster step of the default recipes but nip's three keeps its brewer's steady effort: regression test", () => {
    const { recipes, brewers } = valid(loadRecipes(noFiles));
    const others: string[] = [];
    for (const name of ['nip', 'mash', 'deep-mash', 'mash-in']) {
      for (const stepId of recipes.find(name)?.steps ?? []) {
        const found = brewers.find(name, stepId);
        if (found?.brewer.output.schema !== 'tasting') continue;
        if (HIGH.has(`${name}/${stepId}`)) continue;
        others.push(`${name}/${stepId}`);
        assert.equal(found.brewer.effort, 'steady', `${name}/${stepId}`);
      }
    }
    // The plan Tasters of mash and deep-mash, and nip's design conformance, are among them.
    assert.ok(others.includes('nip/design-conformance'), others.join(', '));
    assert.ok(others.includes('mash/coverage'), others.join(', '));
    assert.ok(others.includes('deep-mash/security'), others.join(', '));
  });
});

/** The text only the design-conformance lens writes into a Taster's prompt (ADR 0352). */
const FIRST_READ = /Your first tool call reads the repository's instruction file/;
/** What the default Taster told every diff Taster before ADR 0352 (ADR 0337). */
const TASTER_READ = /your first tool call reads the repository's instruction file/i;

/** Batch 12-1 brewing `recipe` with `stepId`'s first attempt started in its worktree. */
const eventsOf = (recipe: string, stepId: string): Event[] => {
  const ref = { batchId: '12-1', stepId, attempt: 1 };
  const path = join('/work', `${stepId}-1`);
  return [
    {
      type: 'batch.ordered',
      batchId: '12-1',
      order: { issue: 12 },
      routeBy: '2026-11-08T13:00:00.000Z',
    },
    { type: 'batch.recipe_chosen', batchId: '12-1', recipe, reason: 'label', source: 'label' },
    { type: 'step.scheduled', ...ref, deadlineAt: '2026-11-08T13:00:00.000Z' },
    {
      type: 'step.started',
      ...ref,
      session: { id: '0f8fad5b-d9cb-469f-a165-70867728950e', worktree: path },
      worktree: {
        repo: 'acme/api',
        path,
        branch: `foedrum/12-1/${stepId}/1`,
        commit: 'c'.repeat(40),
      },
    },
  ];
};

const MODELS: ModelsConfig = claudeModels({
  standard: 'claude-sonnet-5-5',
  strong: 'claude-opus-5-5',
});

/** The prompt and the `claude` call of `stepId`'s first attempt in `recipe`, as an attempt plans them. */
const planOf = async (
  stepId: string,
  { files = noFiles, recipe = 'nip', models = MODELS } = {},
): Promise<{ prompt: string; call: { model: string; effort: string } }> => {
  const plans = createAttemptPlans({
    state: () => fold(eventsOf(recipe, stepId)),
    brewers: valid(loadRecipes(files)).brewers,
    models,
    repoTools: () => [],
    clone: (repo) => join('/clones', repo),
    sandbox: false,
    workRoot: join('/root'),
    env: { base: { PATH: '/usr/bin' }, forced: {} },
    platform: 'linux',
    orderText: async () => 'Add a --json flag to status.',
    orderComments: async () => [],
    git: async (_cwd, args) => ({
      code: 0,
      stdout: args[0] === 'log' ? 'f00dfee Add a --json flag\n' : 'diff --git a/x b/x\n',
      stderr: '',
    }),
    files: { read: () => ({ kind: 'missing' }), makeFolder: () => {} },
    random: () => Buffer.from('0123456789abcdef0123456789abcdef', 'hex'),
  });
  const ref = { batchId: '12-1', stepId, attempt: 1 };
  const { prompt, call } = await plans.plan({ ref, limits: plans.limits(ref) });
  return { prompt, call };
};

describe("nip's Tasters at high effort, without the Taster's read of the rules (#935, ADR 0352)", () => {
  it("a nip brew's correctness, acceptance and security sessions start at high effort and are not told to read the instruction file first; design conformance's still is", async () => {
    for (const stepId of ['correctness', 'acceptance', 'security']) {
      const { prompt, call } = await planOf(stepId);
      assert.equal(call.effort, 'high', stepId);
      assert.equal(call.model, 'claude-sonnet-5-5', stepId);
      assert.doesNotMatch(prompt, TASTER_READ, stepId);
      assert.doesNotMatch(
        prompt,
        /read the instruction file at the root of your working directory/,
      );
    }
    const { prompt, call } = await planOf('design-conformance');
    assert.equal(call.effort, 'medium');
    assert.match(prompt, FIRST_READ);
  });

  it("a step's effort overrides its brewer's on that step alone", async () => {
    const files: BreweryFiles = {
      ...noFiles,
      recipes: [
        {
          path: 'recipes/amber.jsonc',
          text: recipeText(
            'amber',
            [
              { id: 'implement', brewer: 'cellarman' },
              {
                id: 'deep',
                brewer: 'taster',
                lens: 'diff/correctness',
                effort: 'thorough',
                onFindings: { goto: 'implement', maxRounds: 1 },
              },
              {
                id: 'plain',
                brewer: 'taster',
                lens: 'diff/correctness',
                onFindings: { goto: 'implement', maxRounds: 1 },
              },
              { action: 'openPullRequest' },
            ],
            { testFirst: false },
          ),
        },
      ],
    };
    assert.equal((await planOf('deep', { files, recipe: 'amber' })).call.effort, 'xhigh');
    assert.equal((await planOf('plain', { files, recipe: 'amber' })).call.effort, 'medium');
  });

  it("refuses a step's effort that is not a brewer's effort: regression test", () => {
    const files = (effort: string): BreweryFiles => ({
      ...noFiles,
      recipes: [
        {
          path: 'recipes/amber.jsonc',
          text: recipeText(
            'amber',
            [
              { id: 'implement', brewer: 'cellarman' },
              {
                id: 'deep',
                brewer: 'taster',
                lens: 'diff/correctness',
                effort,
                onFindings: { goto: 'implement', maxRounds: 1 },
              },
              { action: 'openPullRequest' },
            ],
            { testFirst: false },
          ),
        },
      ],
    });
    const refused = loadRecipes(files('ultra'));
    assert.equal(refused.valid, false);
    assert.match(
      refused.valid ? '' : refused.problems.join('\n'),
      /recipes\/amber\.jsonc: .* at steps\[1\]/,
    );
    assert.ok(loadRecipes(files('careful')).valid);
  });

  it("a Brewery's models.jsonc that maps careful to xhigh starts a careful step at --effort xhigh (ADR 0397)", async () => {
    const models: ModelsConfig = {
      ...MODELS,
      claude: { ...MODELS.claude, efforts: { ...CLAUDE_EFFORTS, careful: 'xhigh' } },
    };
    assert.equal((await planOf('correctness', { models })).call.effort, 'xhigh');
    assert.equal((await planOf('design-conformance', { models })).call.effort, 'medium');
  });

  it("a blind-tasting swap of the Taster moves its model and keeps a step's own effort", async () => {
    const swapped: ModelsConfig = { ...MODELS, brewers: { taster: 'strong' } };
    const { call } = await planOf('correctness', { models: swapped });
    assert.equal(call.model, 'claude-opus-5-5');
    assert.equal(call.effort, 'high');
  });
});
