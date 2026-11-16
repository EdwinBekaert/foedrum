# Working on timesheet

timesheet adds up the hours a care home's staff work.

## Rules

- A time of day is read only through `parseTime` in `src/time.mjs`, which refuses one that is not `HH:MM`.
- Tests use `node:test` and `node:assert`, and plain data.
