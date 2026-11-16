import assert from 'node:assert/strict';
import { test } from 'node:test';
import { InputError } from '../../src/errors.mjs';
import * as parcel from '../../src/parcel.mjs';

test('reads kilograms and grams as grams', () => {
  assert.deepEqual([parcel.parseWeight('2.5kg'), parcel.parseWeight('800g')], [2500, 800]);
});

test('a weight it cannot read is refused with an InputError', () => {
  for (const text of ['heavy', '12lb']) assert.throws(() => parcel.parseWeight(text), InputError);
});
