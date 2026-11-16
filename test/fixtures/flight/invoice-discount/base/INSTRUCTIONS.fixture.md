# Working on invoice

invoice adds up a small shop's invoices.

## Rules

- Every amount is a whole number of cents, never a fraction of one.
- A share of an amount is computed as `amount * part / whole`, multiplying before dividing, and rounded once, at the end, through `roundCents` in `src/money.mjs`, which rounds half a cent away from zero.
- Amounts are shown only through `formatCents`.
- Tests use `node:test` and `node:assert`, and plain data.
