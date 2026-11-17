# 0242. A repository can name a fast local test, and its pull request checks are the full gate

Date: 2026-11-17 · Status: Accepted · Amends [0023](0023-language-independent-recipes.md) (a repository's `checks` may name a sixth command, `testChanged`) and [0282](0282-a-stale-test-map-sends-back-the-change-that-made-it-and-the-maltster-surveys-a-new-one.md) (a run of `testChanged` judges no freshness)

## Context
`foedrum.jsonc` maps a repository's five checks to commands ([ADR 0023](0023-language-independent-recipes.md)).
A check step runs all five in the check sandbox on the Brewery's machine, every round of every batch.
Since #553 Foedrum also waits for the checks the code host runs on the batch's pull request ([ADR 0213](0213-an-open-pull-request-s-checks-on-its-head-are-recorded-once-they-finish.md)), and since #568 a failing one sends the batch back to its fix step.
So a repository whose suite takes twenty minutes runs it locally in every round, side by side with other batches, and then once more in its CI.

Foedrum's own repository settled the same cost for its sessions in [ADR 0241](0241-each-test-runs-at-the-stage-where-it-pays-the-check-runs-the-test-files-a-change-reaches.md): the local check runs the tests a change reaches, and the pull request's CI runs everything and is the merge gate.
Test runners already offer that reading for a change (`vitest run --changed <ref>`, `jest --changedSince <ref>`, `pytest --testmon`), each from a commit.

## Decision

### A repository may name a test of the changed code
- `checks` takes an optional `testChanged` command beside `test`, written like the others (one line, or `{ "run", "windows", "macos", "linux" }`), for example `"testChanged": "npx vitest run --changed {base}"`.
- Each of its lines holds `{base}`, which a check step replaces with the commit the batch's change starts from: the base it merged last, else its start ([ADR 0164](0164-a-batch-merges-its-base-before-its-last-check.md)). That is always a full sha read from git, so it never needs quoting.
  A line without `{base}` is refused when `foedrum.jsonc` loads, and so is `testChanged` with a `test` of `null`.
- Without `testChanged` nothing changes.

### Setting it is the promise that the pull request's checks run the full test
- A repository that sets `testChanged` says that the checks the code host runs on its pull requests run the full `test`, so the pull request's checks are the full gate, and Foedrum already waits for them and sends a failure back (ADR 0213, #568).
- The engine does not check the promise: `foedrum doctor` states it for each repository that sets `testChanged`, `<repo>: the check step runs only testChanged; your pull request's CI must run the full test`, and for every other repository that the check step runs the full test.

### Only a plain check step runs it
- A check step whose checks name `test` runs `testChanged` in its place, when the repository sets it and the batch's change has a start; with no start it runs `test`.
- These keep the full `test`, since each reads every module's report or every test: the red proof ([ADR 0274](0274-the-red-proof-reads-line-coverage-of-the-change-and-a-test-map-not-test-names.md)), the survey's check ([ADR 0298](0298-the-maltster-s-survey-ends-without-a-session-for-a-fresh-map-and-its-check-sends-a-disagreement-back-once.md)), Brett's test runs in scratch trees ([ADR 0313](0313-the-engine-runs-brett-s-mutants-in-scratch-trees-against-a-fresh-baseline.md)), and the checks of an open pull request's merged tree ([ADR 0203](0203-an-open-pull-request-s-checks-run-on-its-merged-tree-when-its-base-moves.md)).
- The checks a brewer runs before its end ([ADR 0381](0381-a-brewer-that-writes-code-runs-the-quick-checks-before-its-end-and-is-sent-back-once.md)) stay as they are; telling the Gauger and the Cellarman to run `testChanged` while they work is #1135.

### Its reading says so
- The reading of a `testChanged` run is the test check's, `check: "test"`, with the line that ran, `{base}` replaced, as its `command`, and `changed: true`.
- Its coverage still judges the changed lines ([ADR 0274](0274-the-red-proof-reads-line-coverage-of-the-change-and-a-test-map-not-test-names.md)): the tests that cover them are the ones it runs.
- It judges no freshness of the test map ([ADR 0282](0282-a-stale-test-map-sends-back-the-change-that-made-it-and-the-maltster-surveys-a-new-one.md)): a module whose tests it did not run wrote no report, which says nothing of the map. Freshness by manifests before the run stays.

### Foedrum's own repository uses it
- `npm run check -- --base <commit>` reads the change from that commit, a full commit id, instead of the merge base with `origin/main` (`checkMode` in `scripts/check.ts`, `affectedByChange` in `scripts/affected-tests.ts`), and is refused with `--all` or `--no-tests`, which read no change.
- Foedrum's own `testChanged` is `npm run check -- --base {base}`: the test files the change reaches ([ADR 0241](0241-each-test-runs-at-the-stage-where-it-pays-the-check-runs-the-test-files-a-change-reaches.md)), one command on every system, while its CI runs every test file on every leg.

## Consequences
- A repository with a slow suite and a CI that runs it pays for the full suite once per pull request head, in its CI, instead of once per round on the Brewery's machine.
- A test the change breaks that `testChanged` does not reach fails in the pull request's checks, and the batch goes back to its fix step a round later than it would have from the check step.
- A repository that sets `testChanged` while its CI does not run the full test has no full gate before the merge; doctor's line says what it promised.
- The test map's freshness by runs is read only on the full runs of the red proof and the survey, so a stale map shows a round later.
- An existing Brewery need do nothing: without `testChanged` every check step runs `test` as before. A Brewery that sets it sees `changed` on its test readings and doctor's line.

## Alternatives considered
- **A `ciGate: true` field the repository sets.** One more field for what setting `testChanged` already says: a repository with no CI on its pull requests has no reason to set it.
- **Reading from the code host whether pull requests have checks.** The check step runs before the batch opens its pull request, so there is nothing of the batch's to read; reading the checks of earlier pull requests would make the first batch run the full test and a later one `testChanged` with nothing in `foedrum.jsonc` changed, and branch protection needs admin rights to read.
- **Foedrum works out the changed tests itself, as `npm run check` does.** That needs each language's import graph; the repository's test runner already knows it.
- **`testChanged` in the red proof too.** The red proof reads every module's report through the test map; a run that skips modules would read as modules no line reaches.
