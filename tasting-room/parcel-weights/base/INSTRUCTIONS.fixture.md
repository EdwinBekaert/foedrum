# Working on parcel

parcel reads what a person types at a post office counter to print a parcel's label.

## Rules

- A value a person typed that cannot be read is refused by throwing an `InputError` from `src/errors.mjs`, never a plain `Error`: the counter shows an `InputError`'s message and asks again, while any other error stops the program.
- Tests use `node:test` and `node:assert`, and plain data.
