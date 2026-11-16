# 0404. The Flight's tasting room is a folder of orders, each proved by its hidden tests

Date: 2026-11-16 · Status: Accepted

## Context
[docs/design/evaluation.md](../design/evaluation.md) designs a Flight: known orders brewed and scored, with hidden acceptance tests the brewers never see.
No order exists, so a change to a recipe, a prompt, a lens or a model is judged by reading its pull requests, one run each.
One run says little: the necessity lens, run alone on the same change and setup, found its defect in 1 of 3 runs on 2026-10-27 and in 3 of 3 on 2026-11-16.
The milestone table names "the tasting room repository" for M4 without saying what it is.
#562 sets the orders' format and proves them; #1082 adds 7 orders, #1083 brews them and #1084 compares two Flights.

## Decision
- **Decided with the maintainer on 2026-11-16:**
  - the tasting room is a folder in Foedrum, `test/fixtures/flight/`, not a repository of its own: each order will be brewed on the fake code host (#1083), as `scripts/tasting-compare.ts` brews its seeded change ([ADR 0224](0224-the-default-recipes-taste-apart-or-together-as-a-seeded-comparison-measured.md)), with no real GitHub. The milestone table's "tasting room repository" is this folder;
  - the first set will be 10 small made-up orders, 3 here and 7 in #1082, each on a tiny repository with one trap a weaker setup can miss: a house rule in the repository's instruction file, a design page the change must update, or an edge case only the hidden tests check;
  - a Flight will brew each order 3 times per setup (#1083), and a report will call a difference only when one setup passes every run and the other at most one (#1084); anything else is "too close to call".
- **An order is a folder of plain files**, not patches as the seeded change keeps:
  - `order.md`, the issue text, its title on the first line;
  - `order.json`, the trap's kind and a line a person reads, and `allowedPaths`, the path prefixes the change may touch;
  - `base/`, the starting repository, plain Node with `node:test` and no dependencies, so nothing needs `npm ci`;
  - `solution/`, the reference solution, the files it adds or replaces over the base;
  - `hidden/`, the hidden tests, all under `test/hidden/` once laid down, run with `node --test` on their files.

  A patch is hard to write and review by hand, and ten orders would be twenty of them; the seeded change keeps patches because it is one fixed brewed diff, which a reference solution is not.
- **No fixture file is named `CLAUDE.md` or `AGENTS.md`.** A base keeps its instruction file as `INSTRUCTIONS.fixture.md`, and `withLayer` in `scripts/flight-orders.ts` lays it down as `CLAUDE.md`. Claude Code loads a nested `CLAUDE.md` when a session reads files in its folder, and `/brew-review`'s lenses read the repository's instruction files as rules, so a fixture's rule would reach Foedrum's own sessions and reviews.
- **A brewer is to see only the base and `order.md`.** When #1083 comes, its runner will build the target from the starting tree alone (`startingTree`), give `order.md` as the issue, and lay `hidden/` over a scratch clone of the head after the batch (`withLayer`); until then neither function has a caller outside the proof. Whether a brewer's file tools can reach the fixtures above its worktree, since the scratch runs sit inside this checkout, is for #1083 to confirm on a dry run.
- **The proof.** For every order, its hidden tests fail on the starting tree and pass with the reference solution laid over it; a run that does not finish fails the proof. `scripts/flight-orders.ts` reads and checks an order, lists its two runs and judges an exit code, with unit tests on plain data. The runs themselves start `node`, which no unit test may ([ADR 0021](0021-unit-tests-spawn-no-processes.md)), so they are `test/integration/flight-orders.test.ts`, which CI runs on all three systems. Its red step is plain: it fails because no order exists yet.
  The proof reads the hidden tests' exit as a whole, so one hidden test that already passes on the base beside one that fails is not found; whether the hidden tests catch the order's trap is checked by review and by a break per test, not by the proof.
  A commit that adds an order says in its message that the integration tests it adds are tests of new behaviour, since the orders are what they test and no commit can show them failing first, and its pull request shows a break per test: the order changed so that test, and only it, fails.
- **The first 3 orders**, one per kind of trap: `invoice-discount` (house rule), `shelf-tags` (design page) and `timesheet-night` (edge case).

### A Brewery's files
None: these are fixtures, a test and docs of Foedrum's own repository, and nothing in a Brewery changes.

## Consequences
- An order is checked by a test before any Flight spends a token on it: hidden tests that all pass on the base, or that fail with the reference, are found by `npm run test:integration`.
- The hidden tests are in Foedrum's repository, so anyone reading it, a person or a model, can see them; only a brewer working in its worktree cannot.
- A new order is a folder of plain files that #1082 writes by hand.

## Alternatives considered
- **A tasting-room repository of its own:** a second repository and a login for each Flight, which the fake code host does not need.
- **Patches, as the seeded change keeps:** see above.
- **The proof as a unit test, as #562 first asked:** each run starts `node --test`, which a unit test may not.
