// The default cleanup recipe (ADR 0380): a `tend` recipe of the Cellarer's three jobs, which a
// Brewery issue's `recipe:cleanup` label starts.

import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { FOEDRUM_DEFAULTS, readBreweryFiles } from '../../src/engine/brewery-files.ts';
import type { Batch } from '../../src/engine/fold.ts';
import { loadRecipes } from '../../src/engine/recipe-files.ts';

describe('the default cleanup recipe (ADR 0380)', () => {
  it("is a tend recipe of the Cellarer's shelve, sweep and expire, ending with no pull request", () => {
    const loaded = loadRecipes(readBreweryFiles(join(FOEDRUM_DEFAULTS, 'no-such-brewery')));
    assert.ok(loaded.valid, loaded.valid ? '' : loaded.problems.join('\n'));
    const cleanup = loaded.recipes.find('cleanup');
    assert.equal(cleanup?.type, 'tend');
    assert.deepEqual(cleanup?.steps, ['shelve', 'sweep', 'expire']);
    assert.deepEqual(
      cleanup?.steps.map((id) => cleanup.action(id)),
      ['shelve', 'sweep', 'expire'],
    );
    const fresh = { steps: new Map(), lane: { kind: 'brewing' } } as unknown as Batch;
    assert.deepEqual(cleanup?.after(fresh, 'expire'), { kind: 'done', pullRequests: [] });
  });
});
