Run the pantry for a shared household

A household keeps one pantry file in a folder its members sync, and wants more from it than `add` and `list`.

## What to build

- [ ] `expiringSoon(items, today, days)` in `src/pantry.mjs` returns the items best before at most `days` days after `today`, those already past included, soonest first, and `node src/cli.mjs remind <file> [--days <n>]` prints them as `list` does, with 3 days when the option is left out
- [ ] a pantry file with an item whose best-before date is not a date is refused when it is read, with an error naming the item
- [ ] `addItem(items, item, today)` marks an item best before `today` with `flagged: true`, and `list` shows the mark
- [ ] `node src/cli.mjs notify <file> <command>` runs `<command>` once per item best before in the next 3 days, with the item's name, so a household can send itself a message
- [ ] `node src/cli.mjs stats <file>` prints the items per month, per name and per shelf life, as text, CSV, JSON, HTML, Markdown or YAML
- [ ] `node src/cli.mjs remove <file> <name>` removes the item of that name
- [ ] `node src/cli.mjs rename <file> <old> <new>` renames an item
- [ ] `save` keeps the text it replaces in `<file>.bak`
- [ ] a `save` that fails leaves the pantry file whole
- [ ] README.md says how to use the new commands

## Later

- A reminder by e-mail.
