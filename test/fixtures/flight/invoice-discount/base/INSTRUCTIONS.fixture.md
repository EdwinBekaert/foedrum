# Working on invoice

invoice adds up a small shop's invoices.

## Rules

- Every amount is a whole number of cents, never a fraction of one.
- A share of an amount is computed as `amount * part / whole`, multiplying before dividing, and rounded once, at the end, through `roundCents` in `src/money.mjs`, which rounds half a cent away from zero.
- What is rounded is the amount a customer pays: an amount left after a cut is computed as its own share of the total, never as the total less a rounded cut.
- Amounts are shown only through `formatCents`.
- Tests use `node:test` and `node:assert`, and plain data.
