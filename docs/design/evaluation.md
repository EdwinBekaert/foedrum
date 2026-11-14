# Evaluation: Flight and blind tasting

- A public **tasting room** repository with seeded issues per recipe and **hidden acceptance tests** brewers never see; planted bugs for Infection check; pull requests with planted defects for Guest tasting.
- **Real batches become samples:** any batch that got stuck or needed human fixes can be exported into the Flight.
- **Metrics per recipe × brewer × model:** hidden-test pass rate, first-attempt gravity pass rate, retries, stuck rate, tokens, duration, diff size, planted-defect recall.
- **Blind tasting:** `foedrum taste --model <id> [--brewer <name>]` swaps one brewer's model, runs the Flight several times (agent runs are noisy) and compares with the baseline.
  Its first piece is in the comparison script, not a command: `node scripts/tasting-compare.ts --real --brewer cellarman --model <id> --effort <effort>` runs a real Cellarman over three brewed heads from their own failing tests, on a model and effort given as settings, for a person to score blind ([ADR 0394](../adr/0394-tasting-compare-real-runs-a-real-cellarman-on-a-model-and-effort-it-is-given.md)).
  With `--order-text plan` that Cellarman starts from the sub-order the real Brewmaster wrote for the order, kept by `--real --sub-orders`, to measure what an Opus plan gives a Cellarman on Sonnet ([ADR 0396](../adr/0396-tasting-compare-real-starts-a-cellarman-run-from-the-brewmaster-s-kept-sub-order.md)).
- **Model watcher:** when Anthropic lists a new model, Foedrum runs blind tasting per brewer and opens a pull request on the Brewery that updates `models.jsonc`, with the report as its description.
- The same harness gates changes to Foedrum's own default brewers and recipes.
