Remind of the items best before soon

A household wants to see which food to use first: the items best before in the next few days, and those already past.

## What to build

- [ ] `expiringSoon(items, today, days)` in `src/pantry.mjs` returns the items best before at most `days` days after `today`, those already past included, soonest first
- [ ] `node src/cli.mjs remind <file> [--days <n>]` prints them, one per line, as `list` does
- [ ] without `--days`, `n` is the number in `.pantryrc` next to the pantry file, else in `~/.pantryrc`, else 3
- [ ] a test pins down `expiringSoon`
- [ ] README.md says how to use `remind`

## Later

- A reminder by e-mail.
