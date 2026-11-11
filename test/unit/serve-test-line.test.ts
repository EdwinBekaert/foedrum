// `foedrum serve` hands a brewer that asks for it the Brewery's test line of its repository
// (ADR 0376): through the driver's wiring, from foedrum.jsonc's test check.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { runServe } from '../../src/cli/serve.ts';
import { serveSetup } from '../../src/cli/serve-config.ts';
import { brewer, config, local, serveInputs } from '../helpers/serve-brewery.ts';
import { serveFixture } from '../helpers/serve-fixture.ts';

describe("foedrum serve: the Brewery's test line", () => {
  const f = serveFixture();

  it('reaches the brewer that asks for it, as foedrum.jsonc gives it', async () => {
    const asking = brewer.replace(
      '"inputs": [{ "name": "order", "from": "order" }]',
      '"inputs": [{ "name": "order", "from": "order" }, { "name": "testLine", "from": "test-line" }]',
    );
    const web = {
      checks: {
        build: null,
        typecheck: null,
        lint: null,
        format: null,
        test: 'node --test --test-reporter=junit --test-reporter-destination=junit.xml',
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
    assert.match(
      f.plans[0]?.prompt ?? '',
      /source="the Brewery's test line for acme\/web" name="testLine">\nnode --test --test-reporter=junit --test-reporter-destination=junit\.xml\n</,
    );
  });
});
