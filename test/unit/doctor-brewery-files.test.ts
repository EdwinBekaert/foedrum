import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { diagnose } from '../../src/cli/doctor.ts';
import { linux } from '../helpers/doctor-facts.ts';
import { config, serveInputs } from '../helpers/serve-brewery.ts';

// doctor.test.ts holds the same files against the setup's lines; these name each line by its
// own text, so a check dropped or given twice fails here (ADR 0438).
describe('diagnose: three broken Brewery files at once', () => {
  const served = serveInputs().files;
  const files = {
    ...served,
    config: config({ users: [] }),
    models: '{ "models": { "builder": "claude-sonnet-5-5" } }',
    brewery: { recipes: [{ path: 'recipes/stout.jsonc', text: '{' }], brewers: [] },
  };
  const required = diagnose({
    ...linux(),
    config: files.config,
    models: files.models,
    brewery: files.brewery,
  }).problems.filter(({ required: isRequired }) => isRequired);
  const lines = required.map(({ what, fix }) => `${what}: ${fix}`);

  it('gives a line for the users, one for models.jsonc and one for the recipes, each once', () => {
    const counts = [
      /list the GitHub users who may order work/,
      /^models\.jsonc: .*Unrecognized key: "models"/,
      /^the Brewery's recipes are not valid: recipes\/stout\.jsonc: /,
    ].map((pattern) => lines.filter((line) => pattern.test(line)).length);
    assert.deepEqual(counts, [1, 1, 1], lines.join('\n'));
    assert.equal(lines.length, 3, lines.join('\n'));
  });
});
