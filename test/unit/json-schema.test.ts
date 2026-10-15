import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { writeJsonSchemas } from '../../src/schemas/json-schema.ts';
import { makeTempDir } from '../helpers/temp-dir.ts';

const committed = join(import.meta.dirname, '..', '..', 'schemas');

const readAll = (dir: string): Record<string, string> =>
  Object.fromEntries(
    readdirSync(dir)
      .sort()
      .map((name) => [name, readFileSync(join(dir, name), 'utf8')]),
  );

describe('writeJsonSchemas', () => {
  const first = makeTempDir('json-schema');
  const second = makeTempDir('json-schema');
  after(() => {
    first.remove();
    second.remove();
  });
  writeJsonSchemas(first.path);
  writeJsonSchemas(second.path);
  const generated = readAll(first.path);

  it('writes one JSON Schema file per schema', () => {
    assert.deepEqual(Object.keys(generated), ['event.json', 'out-doc.json', 'step-outcome.json']);
  });

  it('writes 2020-12 JSON Schemas as LF-terminated JSON', () => {
    for (const [name, text] of Object.entries(generated)) {
      assert.ok(text.endsWith('}\n') && !text.includes('\r'), name);
      const schema = JSON.parse(text) as { $schema?: string };
      assert.equal(schema.$schema, 'https://json-schema.org/draft/2020-12/schema', name);
    }
  });

  it('describes the input form, so fields with a default are optional', () => {
    const outDoc = JSON.parse(generated['out-doc.json'] ?? '{}') as {
      oneOf?: { properties: Record<string, unknown>; required: string[] }[];
    };
    const done = outDoc.oneOf?.find((variant) =>
      JSON.stringify(variant.properties.status).includes('"done"'),
    );
    assert.ok(done, 'a variant for status done');
    assert.ok('assumptions' in done.properties);
    assert.deepEqual(done.required.sort(), ['status', 'summary']);
  });

  it('gives the key of effect.applied the shape of a canonical effect key', () => {
    const event = JSON.parse(generated['event.json'] ?? '{}') as {
      oneOf?: { properties?: { type: { const?: string }; key?: { pattern?: string } } }[];
    };
    const applied = event.oneOf?.find(
      (variant) => variant.properties?.type.const === 'effect.applied',
    );
    const pattern = applied?.properties?.key?.pattern;
    assert.ok(pattern, 'a pattern for the key of effect.applied');
    const key = new RegExp(pattern);
    for (const text of [
      '["b1","open-pr",1,"pull_request"]',
      JSON.stringify(['a"b', 'c\\d', 12, 'e\n']),
    ]) {
      assert.match(text, key);
    }
    for (const text of [
      'b1/open-pr/1/pr',
      '["b1","open-pr",0,"pr"]',
      '["b1","open-pr",1]',
      'x["b1","open-pr",1,"pr"]',
    ]) {
      assert.doesNotMatch(text, key);
    }
  });

  it('is reproducible', () => {
    assert.deepEqual(readAll(second.path), generated);
  });

  it('matches the committed files in schemas/ (run npm run schemas after changing a schema)', () => {
    assert.deepEqual(readAll(committed), generated);
  });
});
