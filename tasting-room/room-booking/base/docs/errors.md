# What `book` refuses

`book(bookings, request)` answers `{ ok: true, bookings }` with `request` added, or `{ ok: false, code }` with one of these codes.

| Code | When |
|---|---|
| `UNKNOWN_ROOM` | The request names a room the office does not have. |
| `BAD_HOURS` | The request's `from` is not before its `to`, or either is not a whole hour from 0 to 24. |

This page is the one list of the codes `book` answers: the front desk shows each code's line from it, and a code it does not list is shown as an unknown failure.
