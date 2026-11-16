import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as invoice from '../../src/invoice.mjs';

const of = (...cents) => ({ lines: cents.map((priceCents) => ({ priceCents, quantity: 1 })) });

test('a discount leaves a whole number of cents', () => {
  const after = invoice.applyDiscount(of(999), 15);
  assert.ok(Number.isInteger(after), `${after} is not whole cents`);
  assert.equal(after, 849);
});

test('half a cent is rounded away from zero, computed multiplying before dividing', () => {
  // 165 * 70 / 100 is 115.5 exactly; 165 * (1 - 0.3) is 115.49999999999999.
  assert.equal(invoice.applyDiscount(of(165), 30), 116);
});

test('the discount is taken off the whole invoice', () => {
  assert.equal(invoice.applyDiscount(of(100, 200, 300), 25), 450);
});
