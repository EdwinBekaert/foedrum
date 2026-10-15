import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PathSafeId } from '../../src/schemas/ids.ts';

describe('PathSafeId', () => {
  const valid = ['b1', 'plan', 'open-pr', 'a', '7', 'step.2', 'red_proof', 'x'.repeat(64)];
  for (const id of valid) {
    it(`accepts ${id.length > 20 ? `an id of ${id.length} characters` : id}`, () => {
      assert.equal(PathSafeId.parse(id), id);
    });
  }

  // Names that Windows reserves for devices, with or without an extension, in any position.
  const reserved = ['con', 'prn', 'aux', 'nul', 'com1', 'com9', 'lpt1', 'lpt9', 'nul.txt'];
  const invalid: [string, unknown][] = [
    ['an empty id', ''],
    ['an upper-case letter', 'B1'],
    ['a slash', 'a/b'],
    ['a backslash', 'a\\b'],
    ['a colon', 'a:b'],
    ['a space', 'a b'],
    ['a quote', 'a"b'],
    ['a leading dot', '.plan'],
    ['a trailing dot', 'plan.'],
    ['a leading dash', '-plan'],
    ['a trailing dash', 'plan-'],
    ['a leading underscore', '_plan'],
    ['dot', '.'],
    ['dot dot', '..'],
    ['a letter outside ASCII', 'bière'],
    ['a newline', 'b1\n'],
    ['65 characters', 'x'.repeat(65)],
    ...reserved.map((id): [string, unknown] => [`the reserved name ${id}`, id]),
  ];
  for (const [what, value] of invalid) {
    it(`rejects ${what}`, () => {
      assert.equal(PathSafeId.safeParse(value).success, false);
    });
  }

  it('accepts names that only start like a reserved name', () => {
    for (const id of ['console', 'nully', 'com10', 'com0', 'lpt', 'auxiliary']) {
      assert.equal(PathSafeId.parse(id), id);
    }
  });
});
