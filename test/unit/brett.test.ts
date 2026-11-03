// Brett (ADR 0017, ADR 0034, ADR 0311): a default brewer that proposes a few mutants of a batch's
// change as one-line edits in its out doc, read-only. The engine checks them (src/checks/mutants.ts);
// running them comes later (#798). Played on fakes: no model.

import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { attemptLimits } from '../../src/brewers/attempt-plan.ts';
import { createAttemptPlans } from '../../src/brewers/attempt-plans.ts';
import { FOEDRUM_DEFAULTS, readBreweryFiles } from '../../src/engine/brewery-files.ts';
import { fold } from '../../src/engine/fold.ts';
import {
  type BreweryFiles,
  type LoadedRecipes,
  loadRecipes,
} from '../../src/engine/recipe-files.ts';
import type { Event } from '../../src/schemas/events.ts';
import { MOST_MUTANTS, MutantsOutDoc } from '../../src/schemas/out-doc.ts';
import type { Git } from '../../src/workspace/git.ts';
import { recipeText } from '../helpers/brewery-files.ts';

// A Brewery with no files of its own: Brett and the Cellarman come from Foedrum's defaults.
const noFiles = readBreweryFiles(join(FOEDRUM_DEFAULTS, 'no-such-brewery'));
const room: BreweryFiles = {
  ...noFiles,
  recipes: [
    {
      path: 'recipes/amber.jsonc',
      text: recipeText(
        'amber',
        [
          { id: 'implement', brewer: 'cellarman' },
          { id: 'mutate', brewer: 'brett' },
          { action: 'openPullRequest' },
        ],
        { testFirst: false },
      ),
    },
  ],
};
const valid = (result: LoadedRecipes) => {
  assert.ok(result.valid, result.valid ? '' : result.problems.join('\n'));
  return result;
};

const start = 'c'.repeat(40);

const edit = (line: number) => ({
  file: 'src/rate.ts',
  line,
  original: 'if (amount > limit) {',
  replacement: 'if (amount >= limit) {',
  description: 'The top rate starts at the limit',
});

describe('the default Brett (defaults/brewers/brett.md)', () => {
  it('the default brett brewer loads with the mutants out doc schema', () => {
    const found = valid(loadRecipes(room)).brewers.find('amber', 'mutate');
    assert.ok(found !== undefined, 'the recipe has no mutate step');
    const { brewer } = found;
    assert.equal(brewer.name, 'brett');
    assert.equal(brewer.output.schema, 'mutants');
    assert.equal(brewer.produces, 'report');
    assert.equal(brewer.access, 'read');
    assert.equal(attemptLimits(brewer).outDoc.schema, MutantsOutDoc);
    // It is told the shape and the limit.
    assert.match(found.instructions, /at most 5 mutants/);
  });

  it('the mutants out doc refuses more than five mutants', () => {
    const doc = (count: number) => ({
      status: 'done',
      summary: 'Mutants of the rate change',
      mutants: Array.from({ length: count }, (_, at) => edit(at + 1)),
    });
    assert.equal(MOST_MUTANTS, 5);
    assert.ok(MutantsOutDoc.safeParse(doc(5)).success);
    assert.equal(MutantsOutDoc.safeParse(doc(6)).success, false);
    // A done with none is valid: there was nothing worth mutating.
    assert.ok(MutantsOutDoc.safeParse(doc(0)).success);
  });

  it("holds the change the engine read with git in a Brett step's prompt", async () => {
    const ref = { batchId: '12-1', stepId: 'mutate', attempt: 1 };
    const worktree = (name: string, commit: string) => ({
      repo: 'acme/api',
      path: join('/work', name),
      branch: `foedrum/12-1/${name}`,
      commit,
    });
    const events: Event[] = [
      {
        type: 'batch.ordered',
        batchId: '12-1',
        order: { issue: 12 },
        routeBy: '2026-10-24T13:00:00.000Z',
      },
      {
        type: 'batch.recipe_chosen',
        batchId: '12-1',
        recipe: 'amber',
        reason: 'label',
        source: 'label',
      },
      {
        type: 'step.scheduled',
        batchId: '12-1',
        stepId: 'implement',
        attempt: 1,
        deadlineAt: '2026-10-24T13:00:00.000Z',
      },
      {
        type: 'step.started',
        batchId: '12-1',
        stepId: 'implement',
        attempt: 1,
        worktree: worktree('implement-1', start),
      },
      {
        type: 'step.finished',
        batchId: '12-1',
        stepId: 'implement',
        attempt: 1,
        outcome: {
          kind: 'succeeded',
          output: { status: 'done', summary: 'Done', assumptions: [] },
        },
      },
      { type: 'step.scheduled', ...ref, deadlineAt: '2026-10-24T13:00:00.000Z' },
      {
        type: 'step.started',
        ...ref,
        session: {
          id: '0f8fad5b-d9cb-469f-a165-70867728950e',
          worktree: join('/work', 'mutate-1'),
        },
        worktree: worktree('mutate-1', 'b'.repeat(40)),
      },
    ];
    const git: Git = async (_cwd, args) => ({
      code: 0,
      stdout: args[0] === 'log' ? 'f00dfee Add the top rate\n' : 'diff --git a/src/rate.ts\n',
      stderr: '',
    });
    const plans = createAttemptPlans({
      state: () => fold(events),
      brewers: valid(loadRecipes(room)).brewers,
      models: { models: { builder: 'claude-sonnet-5-5' }, brewers: {} },
      repoTools: () => [],
      clone: (repo) => join('/clones', repo),
      sandbox: false,
      workRoot: join('/root'),
      env: { base: { PATH: '/usr/bin' }, forced: {} },
      platform: 'linux',
      orderText: async () => 'Add a top rate.',
      git,
      files: { read: () => ({ kind: 'missing' }), makeFolder: () => {} },
      random: () => Buffer.from('0123456789abcdef0123456789abcdef', 'hex'),
    });
    const { prompt } = await plans.plan({ ref, limits: plans.limits(ref) });
    assert.ok(
      prompt.includes(`source="the change since commit ${start}" name="change">\nThe commits`),
      'the prompt does not hold the change as an input',
    );
    assert.match(prompt, /f00dfee Add the top rate/);
  });
});
