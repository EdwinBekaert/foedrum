import assert from 'node:assert/strict';
import { test } from 'node:test';
import { InputError } from '../src/errors.mjs';
import { parsePostcode, parseWeight } from '../src/parcel.mjs';

test('reads a postcode of four digits', () => {
  assert.equal(parsePostcode('9000'), '9000');
});

test('refuses a postcode that is not four digits', () => {
  for (const text of ['900', '90000', 'ghent'])
    assert.throws(() => parsePostcode(text), InputError);
});

test('reads a weight in kilograms or grams as grams', () => {
  assert.deepEqual([parseWeight('1.2kg'), parseWeight('350g')], [1200, 350]);
});

test('refuses a weight it cannot read', () => {
  for (const text of ['', 'kg', '3 stone']) assert.throws(() => parseWeight(text), InputError);
});
