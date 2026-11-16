# Evaluation: the tasting room and the Flight

Foedrum's tests show that its code does what it should ([Testing](testing/README.md)); evaluation measures how well its brewers, recipes, lenses and models do on work like a person's, which no test can pin down, since a model's answer differs from run to run.

## The tasting room

The **tasting room** is `tasting-room/` at the repository's root: Foedrum's benchmark, kept apart from `test/fixtures/`, which holds inputs for tests of Foedrum's own code ([ADR 0404](../adr/0404-the-flight-s-tasting-room-is-a-folder-of-orders-each-proved-by-its-hidden-tests.md), [ADR 0410](../adr/0410-the-tasting-room-holds-all-benchmark-material-a-folder-per-kind.md)).
It has a folder per kind of material, and [its README](../../tasting-room/README.md) says what each is for:
- `orders/`: the Flight's orders, each a tiny made-up repository with one trap a weaker setup can miss, the order's text, **hidden acceptance tests** a brewer never sees and a reference solution;
- `seeded/`: a seeded change with one planted defect per default diff lens and its key, and in `seeded/plan/` a seeded plan with one planted mistake per default plan lens;
- `real/`: the three orders of #879 as they stood when they brewed, and the pinned Taster the real setups start from;
- `lenses/`: planted-defect samples, each a change whose expected findings its README lists.

## What runs today

Every comparison is a script or a skill run by hand from a checkout: a real run needs `claude`'s login and spends tokens, which no test may ([ADR 0057](../adr/0057-real-claude-tests-are-opt-in-and-claude-proofs-leave-the-suite.md)).
Each brews with `foedrum brew`'s own run in a scratch Brewery on the fake code host, keeps its runs and records under `.foedrum/tmp/tasting-compare/`, and goes on where it stopped when run again.
`--dry-run` plays every model step scripted, so it shows what a run will do before any token is spent, and `--runs <n>` sets the runs per setup (3 when left out).

- **The seeded comparison:** `node scripts/tasting-compare.ts` tastes `seeded/`'s change with the seven default diff lenses apart, the seven together and Nip's three as measured together, and prints a table of the planted defects each setup found, the other findings, tokens and time ([ADR 0224](../adr/0224-the-default-recipes-taste-apart-or-together-as-a-seeded-comparison-measured.md)).
  `--model <level or id> --effort <effort>` runs every Taster step on that model and effort, with its records kept apart under `seeded/<model>-<effort>` ([ADR 0405](../adr/0405-the-seeded-comparison-tastes-on-a-given-model-and-effort.md)).
- **The seeded plan:** `--plan` tastes `seeded/plan/` with the seven default plan lenses apart and together and mash's three together, the plan itself scripted ([ADR 0323](../adr/0323-a-seeded-plan-measures-the-plan-lenses-apart-and-together-after-the-merge.md)).
- **Real heads:** `--real` tastes the brewed heads of `real/`'s three orders in fixed Taster setups, #867 also with its maintainer's comment, and writes one blinded list per order with the setups named only in `codes.md`; `--setups` and `--orders` choose among them, and `--comparison <name>` keeps a comparison's runs apart ([ADR 0332](../adr/0332-tasting-compare-real-re-tastes-brewed-heads-and-writes-blinded-lists.md), [ADR 0333](../adr/0333-a-brewer-s-order-holds-the-maintainers-comments.md)).
  It scores nothing: the key is in #879, out of the repository, since a Taster reads the repository.
  Every setup but `today`, `nip`, `deep` and `apart7` starts from `real/taster-reads.md`, so each tastes as it did when it was measured ([ADR 0352](../adr/0352-nip-s-correctness-acceptance-and-security-tasters-run-at-high-effort-without-the-rules-read.md)).
- **A real brewer:** `--real --brewer cellarman --model <id> --effort <effort>` builds the three heads again with a real Cellarman from their own failing tests, and records whether the checks passed, attempts, tokens and time, for a person to score blind ([ADR 0394](../adr/0394-tasting-compare-real-runs-a-real-cellarman-on-a-model-and-effort-it-is-given.md)).
  `--real --sub-orders` keeps the real Brewmaster's plan of each order, and `--order-text plan` then starts the Cellarman from it ([ADR 0396](../adr/0396-tasting-compare-real-starts-a-cellarman-run-from-the-brewmaster-s-kept-sub-order.md)); `--map` runs a real Maltster's map step first, and every brewer run counts each step's `Grep`, `Glob` and `Read` calls ([ADR 0398](../adr/0398-tasting-compare-real-measures-cellarman-with-and-without-the-maltster-s-map.md)).
- **A Taster built from settings:** `--real --brewer taster --model <level or id> --effort <effort> --lenses apart|together --rules reads|bare` tastes the three heads with a Taster setup those four settings make ([ADR 0402](../adr/0402-tasting-compare-real-tastes-with-a-taster-setup-built-from-settings.md)).
  `/brew-tasting` in Claude Code runs it for the settings a person names, has a read-only `taster` agent that never sees the setups score the lists against #879's key, and unblinds its marks with `scripts/tasting-score.ts` into one table ([ADR 0403](../adr/0403-a-skill-tastes-the-settings-a-person-names-and-a-script-unblinds-a-blind-scorer-s-marks.md)).
- **The lens samples:** a change to the review skill or a lens is run by `/brew-review` against `lenses/planted-demo`, the acceptance lens against `lenses/planted-acceptance`, and the test-design lens also against `planted-drifted-fake`, `planted-empty-passes` and `planted-snapshot-only`; the run is compared by hand with the sample's table of expected findings (CLAUDE.md, Tests).
- **The Flight's fairness proof:** `test/integration/flight-orders.test.ts` runs, for every order in `orders/`, its hidden tests on the starting repository, where they must fail, and with the reference solution, where they must pass ([ADR 0404](../adr/0404-the-flight-s-tasting-room-is-a-folder-of-orders-each-proved-by-its-hidden-tests.md)).
  It needs no model, so CI runs it with the other integration tests; it proves an order fair, not that a brewer solves it.
- **A Flight:** `node scripts/flight.ts --recipe <name> [--brewer <name> --model <level or id> --effort <effort>]` brews every order of `orders/` 3 times with a default recipe as it ships, or with only that brewer's steps moved, then runs the order's hidden tests over the head a person gets and records whether they passed, the changes outside its allowed paths and the tokens, turns and time, under `.foedrum/tmp/flight/`; `--dry-run` scripts every brewer and skips the recipe's test-first steps ([ADR 0409](../adr/0409-a-flight-brews-every-tasting-room-order-on-a-recipe-as-it-ships-or-with-one-brewer-swapped.md)).

## Not built yet

- **Flight reports** (#1084): it is to compare two Flights order by order and call a difference only when one setup passes every run and the other at most one.
- **`foedrum taste`:** a command that is to swap one brewer's model, run the Flight several times and compare with the baseline.
  Until it comes, the comparisons above are its pieces.
- **The model watcher** (#1085): when a new model is listed, it is to run a Flight and open a pull request on the Brewery that updates `models.jsonc`, with the report as its description.
- **Real batches as samples:** a batch that went Stuck or needed a person's fixes is to be exported into the tasting room as an order.
- **Metrics per recipe, brewer and model:** hidden-test pass rate, first-attempt gravity pass rate, retries, Stuck rate, tokens, duration, diff size and planted-defect recall; today each comparison prints its own table.
- Planted bugs for Infection check and pull requests with planted defects for Guest tasting.
- The same Flight gating a change to Foedrum's own default brewers and recipes, as the lens samples do by hand today.
