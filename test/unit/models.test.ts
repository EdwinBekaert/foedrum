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
    assert.deepEqual(ModelsConfig.parse({ claude: { models: { standard: 'sonnet' } } }), {
      claude: { models: { standard: 'sonnet' }, efforts: {} },
      brewers: {},
    });
  });

  it('accepts model families, full model ids and a context-window suffix', () => {
    for (const id of [
      'haiku',
      'claude-sonnet-5-5',
      'claude-opus-5-5[1m]',
      'claude-haiku-4-5-20251001',
    ]) {
      assert.equal(accepted({ claude: { models: { standard: id } } }), true, id);
    }
  });

  // Model ids reach the `claude` command line, which runs through a shell on Windows.
  const invalid: [string, unknown][] = [
    ['an unknown field', { claude: {}, effort: {} }],
    ['an unknown field of the claude block', { claude: { model: {} } }],
    ['an upper-case level', { claude: { models: { Standard: 'sonnet' } } }],
    ['an empty model id', { claude: { models: { standard: '' } } }],
    ['a model id with a space', { claude: { models: { standard: 'claude sonnet' } } }],
    ['a model id with a shell operator', { claude: { models: { standard: 'sonnet&calc' } } }],
    ['a model id with a quote', { claude: { models: { standard: 'sonnet"' } } }],
    [
      'a model id starting with a dash',
      { claude: { models: { standard: '--dangerously-skip-permissions' } } },
    ],
    [
      'a model id that is too long',
      { claude: { models: { standard: `claude-${'x'.repeat(128)}` } } },
    ],
    [
      'a brewer name that is not path-safe',
      { claude: { models: { standard: 'sonnet' } }, brewers: { Cellarman: 'standard' } },
    ],
    [
      'a brewer mapped to a level that is only an Object property',
      { claude: { models: { standard: 'sonnet' } }, brewers: { cellarman: 'constructor' } },
    ],
    [
      'a brewer mapped to a level with no model',
      { claude: { models: { standard: 'sonnet' } }, brewers: { cellarman: 'strong' } },
    ],
  ];
  for (const [what, value] of invalid) {
    it(`rejects ${what}`, () => {
      assert.equal(accepted(value), false);
    });
  }
});
