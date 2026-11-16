Tag the books on a shelf

A reader wants to group the books on their shelf, such as "holiday" or "work", and list one group.

## What to build

- [ ] a book can have tags, a list of words; a book with none leaves them out
- [ ] `withTag(books, tag)` in `src/shelf.mjs` returns the books that have `tag`, in the shelf's order
- [ ] `node src/cli.mjs list <file> --tag <tag>` lists only those books
- [ ] a test of `withTag`
