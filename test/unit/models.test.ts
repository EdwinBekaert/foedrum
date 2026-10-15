import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { ModelsConfig } from '../../src/schemas/models.ts';
import { readJsonc } from '../../src/schemas/read.ts';

const fixture = join(import.meta.dirname, '..', 'fixtures', 'config', 'models.jsonc');

const accepted = (value: unknown): boolean => ModelsConfig.safeParse(value).success;

describe('ModelsConfig', () => {
  it('accepts the example models.jsonc, with its comments and $schema', () => {
    const result = readJsonc(readFileSync(fixture, 'utf8'), ModelsConfig);
    assert.equal(result.valid, true, result.valid ? '' : result.reason);
  });

  it('defaults to no per-brewer overrides', () => {
    assert.deepEqual(ModelsConfig.parse({ models: { builder: 'sonnet' } }), {
      models: { builder: 'sonnet' },
      brewers: {},
    });
  });

  it('accepts model families, full model ids and a context-window suffix', () => {
    const models = {
      fast: 'haiku',
      builder: 'claude-sonnet-5-5',
      long: 'claude-opus-5-5[1m]',
      dated: 'claude-haiku-4-5-20251001',
    };
    assert.equal(accepted({ models }), true);
  });

  // Model ids reach the `claude` command line, which runs through a shell on Windows.
  const invalid: [string, unknown][] = [
    ['no models', { brewers: {} }],
    ['an unknown field', { models: {}, effort: {} }],
    ['an upper-case alias', { models: { Builder: 'sonnet' } }],
    ['an alias with a space', { models: { 'my builder': 'sonnet' } }],
    ['an empty model id', { models: { builder: '' } }],
    ['a model id with a space', { models: { builder: 'claude sonnet' } }],
    ['a model id with a shell operator', { models: { builder: 'sonnet&calc' } }],
    ['a model id with a quote', { models: { builder: 'sonnet"' } }],
    ['a model id starting with a dash', { models: { builder: '--dangerously-skip-permissions' } }],
    ['a model id that is too long', { models: { builder: `claude-${'x'.repeat(128)}` } }],
    [
      'a brewer name that is not path-safe',
      { models: { b: 'sonnet' }, brewers: { Cellarman: 'b' } },
    ],
    [
      'a brewer mapped to an alias that is only an Object property',
      { models: { b: 'sonnet' }, brewers: { cellarman: 'constructor' } },
    ],
    [
      'a brewer mapped to an unknown alias',
      { models: { b: 'sonnet' }, brewers: { cellarman: 'c' } },
    ],
  ];
  for (const [what, value] of invalid) {
    it(`rejects ${what}`, () => {
      assert.equal(accepted(value), false);
    });
  }
});
