# The tasting room: the Flight's orders

Each folder here is one order a Flight brews ([ADR 0404](../../../docs/adr/0404-the-flight-s-tasting-room-is-a-folder-of-orders-each-proved-by-its-hidden-tests.md)): a tiny made-up repository, the order's text, one trap a weaker setup can miss, hidden tests a brewer never sees, and a reference solution.
`scripts/flight-orders.ts` reads them, and `test/integration/flight-orders.test.ts` proves, for every order, that its hidden tests fail on the starting repository and pass with its reference solution.

## One order's files

- `order.md`: the order's issue text, its title on the first line. It is the only file a brewer gets.
- `order.json`: `trap`, its `kind` (`house-rule`, `design-page` or `edge-case`) and a `line` a person reads, and `allowedPaths`, the path prefixes the change may touch (one that ends in `/` is a folder).
- `base/`: the starting repository, plain Node with `node:test` and no dependencies.
  Its instruction file is `base/INSTRUCTIONS.fixture.md`, laid down as `CLAUDE.md`: a file named `CLAUDE.md` here would be loaded as a rule by Foedrum's own sessions and reviews.
- `solution/`: the reference solution, the files it adds or replaces over `base/`. It deletes none.
- `hidden/`: the hidden tests, laid over the repository's root after a batch, all under `test/hidden/`, so none replaces a test a brewer wrote. They run with `node --test` on their files.

## The orders

| Order | Trap | The trap |
|---|---|---|
| `invoice-discount` | house rule | The instruction file says every amount is whole cents, a share is computed multiplying before dividing and rounded once through `roundCents`; the order does not repeat it. |
| `shelf-tags` | design page | `docs/format.md` is the one description of the shelf file and lists every field; the order adds a field and never names the page. |
| `timesheet-night` | edge case | A night shift ends the next morning, before its start time; the order mentions night shifts once and asks nothing of them. |
