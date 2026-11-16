# The tasting room: the Flight's orders

The tasting room is Foedrum's benchmark: a Flight is to brew these orders to judge a change to a recipe, a prompt or a model, by whether the brewed change passes each order's hidden tests.
CI runs only the proof that each order is fair, its hidden tests failing on the starting repository and passing with the reference solution, and no model.

Each folder here is one order a Flight brews ([ADR 0404](../docs/adr/0404-the-flight-s-tasting-room-is-a-folder-of-orders-each-proved-by-its-hidden-tests.md)): a tiny made-up repository, the order's text, one trap a weaker setup can miss, hidden tests a brewer never sees, and a reference solution.
`scripts/flight-orders.ts` reads them, and `test/integration/flight-orders.test.ts` proves, for every order, that its hidden tests fail on the starting repository and pass with its reference solution.

## One order's files

- `order.md`: the order's issue text, its title on the first line. When #1083 brews the orders, it is to be the only file a brewer gets.
- `order.json`: `trap`, its `kind` (`house-rule`, `design-page` or `edge-case`) and a `line` a person reads, and `allowedPaths`, the path prefixes the change may touch (one that ends in `/` is a folder).
- `base/`: the starting repository, plain Node with `node:test` and no dependencies.
  Its instruction file is `base/INSTRUCTIONS.fixture.md`, laid down as `CLAUDE.md`: a file named `CLAUDE.md` here would be loaded as a rule by Foedrum's own sessions and reviews.
- `solution/`: the reference solution, the files it adds or replaces over `base/`. It deletes none.
- `hidden/`: the hidden tests, all under `test/hidden/`, laid over the repository's root last, so none is replaced by a solution's file or, once #1083 lays them over a brewed head, by a test a brewer wrote. They run with `node --test` on their files.

The proof runs every order's hidden tests as a whole: they must fail on the base and pass with the solution. Whether they catch the order's trap is checked by review and by a break per test, not by the proof.
A commit that adds an order says in its message that the integration tests it adds are tests of new behaviour, and its pull request shows a break per test: the order changed so that test, and only it, fails.

## The orders

| Order | Trap | The trap |
|---|---|---|
| `invoice-discount` | house rule | The instruction file says every amount is whole cents, a share is computed multiplying before dividing and rounded once through `roundCents`; the order does not repeat it. |
| `shelf-tags` | design page | `docs/format.md` is the one description of the shelf file and lists every field; the order adds a field and never names the page. |
| `timesheet-night` | edge case | A night shift ends the next morning, before its start time; the order mentions night shifts once and asks nothing of them. |
| `plant-watering` | house rule | The instruction file says functions never change the data they are given and return new data; the order asks for a function that records a watering and does not repeat it. |
| `parcel-weights` | house rule | The instruction file says a typed value that cannot be read is refused with an `InputError`, never a plain `Error`; the order says only to refuse it. |
| `quiz-rank` | design page | `docs/commands.md` is the one list of the program's commands; the order adds a command and never names the page. |
| `room-booking` | design page | `docs/errors.md` is the one list of the codes `book` answers; the order adds a code and never names the page. |
