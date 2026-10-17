// The engine killed at random points and restarted (#15, the M0 exit criterion): every batch comes
// to rest, no side effect is applied twice or lost, and no batch sits past its deadline. The run
// count is FOEDRUM_RUNS (a few in npm run check, 1,000 in the nightly run).

import { after, before, it } from 'node:test';
import { restsWithEffectsOnce } from '../helpers/chaos-checks.ts';
import { holdsAcrossKills } from '../helpers/chaos-shrink.ts';
import { makeTempDir, type TempDir } from '../helpers/temp-dir.ts';

let dir: TempDir;
before(() => {
  dir = makeTempDir('chaos-restarts');
});
after(() => dir.remove());

it('every batch comes to rest, no effect is applied twice or lost, none sits past its deadline', () =>
  holdsAcrossKills(dir.path, restsWithEffectsOnce));
