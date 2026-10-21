// Nip and the Gauger, Foedrum's default test-first recipe and brewer (#218, ADR 0017): a Brewery
// without files of its own plans Nip's steps from the defaults, and the Gauger's prompt holds the
// test-design lens's checklist, passed in as an input (ADR 0022, ADR 0098).

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { createAttemptPlans } from '../../src/brewers/attempt-plans.ts';
import { FOEDRUM_DEFAULTS, readBreweryFiles } from '../../src/engine/brewery-files.ts';
import { fold } from '../../src/engine/fold.ts';
import { type LoadedRecipes, loadRecipes } from '../../src/engine/recipe-files.ts';
import type { Event } from '../../src/schemas/events.ts';
import { OutDocFrontmatter } from '../../src/schemas/out-doc.ts';

// A Brewery with no recipes/, brewers/ or lenses/ of its own: a folder that does not exist has
// none, so only Foedrum's defaults load.
const noFiles = readBreweryFiles(join(FOEDRUM_DEFAULTS, 'no-such-brewery'));

const valid = (result: LoadedRecipes) => {
  assert.ok(result.valid, result.valid ? '' : result.problems.join('\n'));
  return result;
};

describe('the default Nip', () => {
  it("plans Nip's steps from the defaults in a Brewery without its own nip.jsonc and gauger.md", () => {
    const loaded = valid(loadRecipes(noFiles));
    assert.deepEqual(loaded.recipes.find('nip')?.steps, [
      'gauge',
      'red',
      'implement',
      'green',
      'open-pull-request',
    ]);
    assert.equal(loaded.brewers.find('nip', 'gauge')?.brewer.name, 'gauger');
    assert.equal(loaded.brewers.find('nip', 'implement')?.brewer.name, 'cellarman');
    assert.deepEqual(loaded.checks.redProof('nip'), { id: 'red', of: 'gauge' });
    assert.deepEqual(loaded.checks.find('nip', 'green'), ['build', 'lint', 'format', 'test']);
    for (const path of [
      'defaults/recipes/nip.jsonc',
      'defaults/brewers/gauger.md',
      'defaults/brewers/cellarman.md',
    ]) {
      assert.ok(loaded.defaults.includes(path), `${path} is not in ${loaded.defaults.join(', ')}`);
    }
  });
});

describe('the default Gauger', () => {
  const gauger = () => valid(loadRecipes(noFiles)).brewers.find('nip', 'gauge');

  it('says up front that stubs throw "not implemented" and that test names are the runner\'s', () => {
    const found = gauger();
    assert.ok(found !== undefined, 'nip has no gauge step');
    // The first section: everything before the second heading.
    const [upFront = ''] = found.instructions.split(/\n(?=## )/).filter((part) => part.trim());
    assert.match(upFront, /throw[^\n]*not implemented/i);
    assert.match(upFront, /names? the (?:test )?runner reports/i);
  });

  it("holds the test-design lens's checklist in its prompt, as an input, not a copy", async () => {
    const found = gauger();
    assert.ok(found !== undefined, 'nip has no gauge step');
    const lens = readFileSync(join(FOEDRUM_DEFAULTS, 'lenses', 'test-design.md'), 'utf8');
    // Not repeated in the brewer file: the brewer and the Taster read the one checklist.
    assert.doesNotMatch(found.instructions, /Tests that cannot fail/);

    const ref = { batchId: '12-1', stepId: 'gauge', attempt: 1 };
    const events: Event[] = [
      {
        type: 'batch.ordered',
        batchId: '12-1',
        order: { issue: 12 },
        routeBy: '2026-10-21T13:00:00.000Z',
      },
      {
        type: 'batch.recipe_chosen',
        batchId: '12-1',
        recipe: 'nip',
        reason: 'label',
        source: 'label',
      },
      { type: 'step.scheduled', ...ref, deadlineAt: '2026-10-21T13:00:00.000Z' },
      {
        type: 'step.started',
        ...ref,
        worktree: {
          repo: 'acme/api',
          path: join('/work', 'gauge-1'),
          branch: 'foedrum/12-1/gauge/1',
          commit: 'c'.repeat(40),
        },
      },
    ];
    const plans = createAttemptPlans({
      state: () => fold(events),
      brewers: valid(loadRecipes(noFiles)).brewers,
      models: { models: { builder: 'claude-sonnet-5-5' }, brewers: {} },
      repoTools: () => [],
      clone: (repo) => join('/clones', repo),
      sandbox: false,
      workRoot: join('/root'),
      env: { base: { PATH: '/usr/bin' }, forced: {} },
      platform: 'linux',
      orderText: async () => 'Add a --json flag to status.',
      files: {
        read: () => ({ kind: 'missing' }),
        makeFolder: () => {},
      },
      sessionId: () => '0f8fad5b-d9cb-469f-a165-70867728950e',
      random: () => Buffer.from('0123456789abcdef0123456789abcdef', 'hex'),
    });
    const { prompt } = await plans.plan({
      ref,
      limits: { outDoc: { file: 'gauge.md', schema: OutDocFrontmatter } },
    });
    assert.ok(
      prompt.includes(
        `source="lens test-design, file defaults/lenses/test-design.md" name="testDesign">\n${lens}\n</`,
      ),
      'the prompt does not hold the lens as an input',
    );
    assert.match(prompt, /source="issue #12 body" name="order">\nAdd a --json flag to status\.\n/);
  });
});
