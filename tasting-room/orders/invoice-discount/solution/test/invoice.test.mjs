import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyDiscount, total } from '../src/invoice.mjs';
import { formatCents, roundCents } from '../src/money.mjs';

const INVOICE = {
  lines: [
    { name: 'tea', priceCents: 250, quantity: 2 },
    { name: 'honey', priceCents: 699, quantity: 1 },
  ],
};

test("adds up an invoice's lines", () => {
  assert.equal(total(INVOICE), 1199);
});

test('rounds half a cent away from zero', () => {
  assert.deepEqual([roundCents(2.5), roundCents(-2.5), roundCents(2.4)], [3, -3, 2]);
});

test('shows cents as euros', () => {
  assert.deepEqual(
    [formatCents(1199), formatCents(5), formatCents(-250)],
    ['11.99', '0.05', '-2.50'],
  );
});

test('takes a percentage off the total, in whole cents', () => {
  assert.equal(applyDiscount(INVOICE, 10), 1079);
  assert.equal(applyDiscount(INVOICE, 0), 1199);
});
