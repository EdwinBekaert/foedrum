import assert from 'node:assert/strict';
import { test } from 'node:test';
import { InputError } from '../src/errors.mjs';
import { parsePostcode } from '../src/parcel.mjs';

test('reads a postcode of four digits', () => {
  assert.equal(parsePostcode('9000'), '9000');
});

test('refuses a postcode that is not four digits', () => {
  for (const text of ['900', '90000', 'ghent'])
    assert.throws(() => parsePostcode(text), InputError);
});
