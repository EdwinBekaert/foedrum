// What an invoice adds up to: plain data in, plain data out.

/** The total of `invoice`'s lines in cents: each line's price times its quantity. */
export function total(invoice) {
  return invoice.lines.reduce((sum, line) => sum + line.priceCents * line.quantity, 0);
}
