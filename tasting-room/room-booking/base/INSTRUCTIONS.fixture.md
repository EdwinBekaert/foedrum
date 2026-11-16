# Working on rooms

rooms books the meeting rooms of a shared office. Its design is in `docs/`.

## Rules

- A booking is `{ room, from, to }`, `from` and `to` whole hours of one day: it holds its room from `from` up to `to`, so a booking that ends at 11 and one that starts at 11 both fit.
- `book` never throws: it answers `{ ok: true, bookings }` with the new list, or `{ ok: false, code }`.
- Tests use `node:test` and `node:assert`, and plain data.
