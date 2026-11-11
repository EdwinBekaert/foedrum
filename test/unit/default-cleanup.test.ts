// The default cleanup recipe (ADR 0380): a `tend` recipe of two actions the engine runs itself,
// which a Brewery issue's `recipe:cleanup` label starts, and which no step offers as a choice.

import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { FOEDRUM_DEFAULTS, readBreweryFiles } from '../../src/engine/brewery-files.ts';
import type { Batch } from '../../src/engine/fold.ts';
import { loadRecipes } from '../../src/engine/recipe-files.ts';

const loaded = loadRecipes(readBreweryFiles(join(FOEDRUM_DEFAULTS, 'no-such-brewery')));
const valid = (() => {
  assert.ok(loaded.valid, loaded.valid ? '' : loaded.problems.join('\n'));
  return loaded;
})();
const fresh = { steps: new Map(), lane: { kind: 'brewing' } } as unknown as Batch;

describe('the default cleanup recipe (ADR 0380)', () => {
  it('is a tend recipe that archives, then sweeps, and ends with no pull request', () => {
    const cleanup = valid.recipes.find('cleanup');
    assert.ok(cleanup !== undefined);
    assert.equal(cleanup.type, 'tend');
    assert.deepEqual(cleanup.steps, ['archive', 'sweep']);
    assert.equal(cleanup.action('archive'), 'archive');
    assert.equal(cleanup.action('sweep'), 'sweep');
    assert.deepEqual(cleanup.after(fresh, 'archive'), { kind: 'step', stepId: 'sweep' });
    assert.deepEqual(cleanup.after(fresh, 'sweep'), { kind: 'done', pullRequests: [] });
  });
});
