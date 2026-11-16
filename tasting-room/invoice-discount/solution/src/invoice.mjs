// What an invoice adds up to: plain data in, plain data out.

import { roundCents } from './money.mjs';

/** The total of `invoice`'s lines in cents: each line's price times its quantity. */
export function total(invoice) {
  return invoice.lines.reduce((sum, line) => sum + line.priceCents * line.quantity, 0);
}

/** `invoice`'s total in cents after `percent` percent off, rounded once (CLAUDE.md). */
export function applyDiscount(invoice, percent) {
  return roundCents((total(invoice) * (100 - percent)) / 100);
}
