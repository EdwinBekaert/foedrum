// `foedrum serve` plans the checks before a brewer's end for a brewer that asks for them (ADR
// 0381): through the driver's wiring, from foedrum.jsonc's checks of the attempt's repository.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { runServe } from '../../src/cli/serve.ts';
import { serveSetup } from '../../src/cli/serve-config.ts';
import { brewer, config, local, serveInputs } from '../helpers/serve-brewery.ts';
import { serveFixture } from '../helpers/serve-fixture.ts';

describe('foedrum serve: the checks before a brewer’s end', () => {
  const f = serveFixture();

  it("plans the repository's checks for the brewer that asks for them, as foedrum.jsonc gives them", async () => {
    const asking = brewer.replace(
      '"maxAttempts": 1',
      '"maxAttempts": 1,\n  "checksBeforeEnd": true',
    );
    assert.notEqual(asking, brewer);
    const web = {
      checks: {
        build: null,
        typecheck: 'tsc',
        lint: { run: 'biome lint', files: true },
        format: null,
        test: null,
      },
    };
    const inputs = serveInputs();
    const result = serveSetup(
      serveInputs({
        files: {
          ...inputs.files,
          config: config({}, web),
          local: local({ workRoot: f.dir.path }),
          brewery: {
            ...inputs.files.brewery,
            brewers: [{ path: 'brewers/cellarman.md', text: asking }],
          },
        },
      }),
    );
    assert.equal(result.kind, 'ready', JSON.stringify(result));
    f.setup = result.kind === 'ready' ? result.setup : assert.fail();
    assert.equal(await runServe(f.setup, f.shell()), 0);
    assert.deepEqual(f.plans[0]?.sendBack?.checks, [
      { check: 'typecheck', command: 'tsc', files: false },
      { check: 'lint', command: 'biome lint', files: true },
    ]);
  });
});
