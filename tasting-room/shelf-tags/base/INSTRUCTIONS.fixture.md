# Working on shelf

shelf keeps a reader's list of books in a JSON file. Its design is in `docs/`.

## Rules

- Only `src/store.mjs` reads and writes files; `parseShelf` checks a shelf file's text where it enters.
- Tests use `node:test` and `node:assert`, and plain data instead of files.
