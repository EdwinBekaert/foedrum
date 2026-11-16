# 0410. The tasting room holds all benchmark material, a folder per kind

Date: 2026-11-16 · Status: Accepted · Amends [0404](0404-the-flight-s-tasting-room-is-a-folder-of-orders-each-proved-by-its-hidden-tests.md) (the tasting room was a folder of orders only, each folder of it an order)

## Context
[ADR 0404](0404-the-flight-s-tasting-room-is-a-folder-of-orders-each-proved-by-its-hidden-tests.md) put the Flight's orders in `tasting-room/`, apart from `test/fixtures/`, which holds inputs for tests of Foedrum's own code.
The rest of Foedrum's benchmark material stayed in `test/fixtures/`: the seeded change and plan `scripts/tasting-compare.ts` tastes ([ADR 0224](0224-the-default-recipes-taste-apart-or-together-as-a-seeded-comparison-measured.md), [ADR 0323](0323-a-seeded-plan-measures-the-plan-lenses-apart-and-together-after-the-merge.md)), the orders of #879 its `--real` mode tastes ([ADR 0332](0332-tasting-compare-real-re-tastes-brewed-heads-and-writes-blinded-lists.md)), and the planted-defect samples that check a lens after its prompt changes.
The Flight's proof read every folder of `tasting-room/` as an order, so nothing else could sit beside them (#1096).

## Decision
- **Decided with the maintainer on 2026-11-16:** benchmark material is not test data, and all of it lives in `tasting-room/`, whether or not a unit test also reads it.
- **A folder per kind of material:**
  - `orders/`, the Flight's orders, each as ADR 0404 describes it; `ORDERS` in `scripts/flight-orders.ts` is the one place their folder is named, and the proof reads it;
  - `seeded/`, the seeded change and its key, with the seeded plan in `seeded/plan/`, on the same base;
  - `real/`, #879's orders and the pinned Taster the real setups start from;
  - `lenses/`, the planted-defect samples of the review skill and the lenses.
- `tasting-room/README.md` says what each folder is for; `test/fixtures/coverage-spike/` stays where it is, since five unit tests read its reports.
- The house-yeast rule on an order's trap applies to `tasting-room/orders/` only.

### A Brewery's files
None: these are files of Foedrum's own repository, and nothing in a Brewery changes.

## Consequences
- A new kind of benchmark material is a new folder of `tasting-room/`, with a row in its README.
- A change to a file under `tasting-room/` still reaches every test file in `npm run check`, as any file that is not TypeScript outside the docs does.
- Older records name the old paths and stay as written.
