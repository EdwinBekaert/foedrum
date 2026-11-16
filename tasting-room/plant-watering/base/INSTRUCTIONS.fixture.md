# Working on garden

garden tells a gardener which plants need water today.

## Rules

- A plant is `{ name, everyDays, lastWatered }`: it needs water every `everyDays` days, and `lastWatered` is the day it last had some.
- A day is a date as `YYYY-MM-DD`, read only through `src/days.mjs`.
- Functions never change the data they are given, neither a list nor an object in it: they return new data.
- Tests use `node:test` and `node:assert`, and plain data.
