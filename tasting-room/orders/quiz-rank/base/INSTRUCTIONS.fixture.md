# Working on quiz

quiz keeps the scores of a pub quiz night in a JSON file. Its design is in `docs/`.

## Rules

- A score is `{ team, points }`: the points a team got in one round. A quiz file is the list of a night's scores.
- Tests use `node:test` and `node:assert`, and plain data instead of files.
