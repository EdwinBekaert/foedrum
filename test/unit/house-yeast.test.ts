import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { HouseYeastRule } from '../../src/schemas/house-yeast.ts';
import { readDoc } from '../../src/schemas/read.ts';

const fixture = join(import.meta.dirname, '..', 'fixtures', 'house-yeast', 'amounts-in-cents.md');

const rule = {
  id: 'no-swallowed-errors',
  scope: {},
  kind: 'structural',
  source: 'https://github.com/acme/web/pull/7#discussion_r2',
  created: '2026-10-15',
  status: 'active',
};

const accepted = (value: unknown): boolean => HouseYeastRule.safeParse(value).success;

describe('HouseYeastRule', () => {
  it('accepts the example rule file', () => {
    const result = readDoc(readFileSync(fixture, 'utf8'), HouseYeastRule);
    assert.equal(result.valid, true, result.valid ? '' : result.reason);
    assert.match(result.valid ? result.body : '', /integers in cents/);
  });

  it('accepts a rule without a scope limit, and a retired rule', () => {
    assert.deepEqual(HouseYeastRule.parse(rule), rule);
    assert.equal(accepted({ ...rule, status: 'retired' }), true);
  });

  it('accepts languages with symbols in their name', () => {
    for (const language of ['c#', 'c++', 'f#', 'objective-c']) {
      assert.equal(accepted({ ...rule, scope: { language } }), true, language);
    }
  });

  const invalid: [string, unknown][] = [
    ['an unknown field', { ...rule, selected: 3 }],
    ['an id that is not path-safe', { ...rule, id: 'No Swallowed Errors' }],
    ['no scope', { ...rule, scope: undefined }],
    ['an unknown scope field', { ...rule, scope: { repository: 'acme/web' } }],
    ['an empty list of globs', { ...rule, scope: { globs: [] } }],
    ['an empty glob', { ...rule, scope: { globs: [''] } }],
    ['an upper-case language', { ...rule, scope: { language: 'TypeScript' } }],
    ['a lens name that is not path-safe', { ...rule, scope: { lens: '../security' } }],
    ['an unknown kind', { ...rule, kind: 'stylistic' }],
    ['an empty source', { ...rule, source: ' ' }],
    ['a created date with a time', { ...rule, created: '2026-10-15T10:00:00Z' }],
    ['a created date that does not exist', { ...rule, created: '2026-13-01' }],
    ['a created date in another format', { ...rule, created: '15/10/2026' }],
    ['an unknown status', { ...rule, status: 'draft' }],
    ['no status', { ...rule, status: undefined }],
  ];
  for (const [what, value] of invalid) {
    it(`rejects ${what}`, () => {
      assert.equal(accepted(value), false);
    });
  }
});
