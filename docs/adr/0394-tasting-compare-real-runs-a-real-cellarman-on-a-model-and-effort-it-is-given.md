# 0394. tasting-compare --real runs a real Cellarman on a model and effort it is given

Date: 2026-11-14 · Status: Accepted · Amends [0332](0332-tasting-compare-real-re-tastes-brewed-heads-and-writes-blinded-lists.md) (a mode that brews the heads again with a real brewer, not only re-tastes them), [0344](0344-tasting-compare-real-measures-a-stronger-model-and-more-effort-apart.md) (a brewer's model and effort as settings of a run, its transcript's model held to the one asked for), [0348](0348-tasting-compare-real-tastes-three-lenses-together-on-sonnet-at-high-effort.md) (no new named setup per model or effort) and [0366](0366-deep-brew-builds-a-change-that-can-reach-a-lot-through-every-diff-lens-and-a-blocking-brett-step.md) (`--orders` also chooses the orders of a `--brewer` run, without `--setups`)

## Context
Only the Tasters were ever measured on another model (#879, #936).
Nothing measured whether a stronger model writes the code without the defect the Tasters were scored on.
`tasting-compare --real` skips the Gauger and scripts Cellarman: it commits each head as it was brewed.
Its setups are a fixed list of named profiles, so each new model or effort needs code and an ADR (ADR 0348).
[docs/design/evaluation.md](../design/evaluation.md) plans M4's blind tasting as one brewer's model swapped and run several times over fixed samples; #995 builds the first piece of that in the comparison script.
The question, answered after the merge by a run by hand: does Cellarman on Sonnet write the code as well as on Opus, from the same failing tests?

## Decision
- **`--real --brewer cellarman --model <id> --effort <level>`** runs Cellarman for real on the three orders of ADR 0332, or on those `--orders` names.
  The model is any id `models.jsonc` accepts (`ModelId`), the effort one of the brewer schema's (`Effort`); each is checked before anything brews, and a refusal exits 2.
  `--brewer` without `--real`, `--model` or `--effort` without `--brewer`, `--brewer` without both, another brewer, and `--setups` beside `--brewer` are refused in one line each.
- **The model and the effort are settings of a run, never a named profile.**
  A run's setup is `<order>-cellarman-<model>-<effort>`, such as `855-cellarman-claude-opus-5-5-xhigh`, so one folder holds the runs of several models and their lists are blinded together.
  A run's scratch folder replaces each character other than letters, digits, `.`, `_` and `-` with `_`, since Windows refuses `:` in a folder's name.
- **Its recipe, `real-brew-cellarman`, is not test-first:**
  1. `gauge`, the Gauger, scripted: it commits the head's files under `test/` as they were brewed, and its out doc names them. The head's other files are Cellarman's.
  2. `implement`, Cellarman, real: its step names the alias `measured` and the given effort, and the scratch Brewery's `models.jsonc` maps `measured` to the given id. No other brewer moves, and no brewer file changes.
  3. `green`, every check, its deadline 30 minutes, sent back to Cellarman once on a failure, as `nip`'s is.
  4. `openPullRequest`, which a recipe that commits must have ([ADR 0084](0084-a-batch-s-commits-end-in-a-pull-request-or-on-a-kept-branch.md)).

  With no red proof the testsUnchanged guard keeps nothing ([ADR 0358](0358-an-older-test-changes-only-in-the-gauger-s-red-commit.md)), and the target needs no test map, which no base of the three holds.
  A head that changes no file under `test/`, or nothing else, is refused: no run would start from failing tests.
  Without the Gauger's stubs, a test may fail to load rather than on an assertion; every run starts from the same tree all the same.
- **The checks are Foedrum's own, after its setup.**
  The scratch Brewery's `foedrum.jsonc` gives the target `setup` `npm ci` (10 minutes) and the checks `typecheck` `npm run typecheck`, `lint` `npm run lint` and `test` `npm run check`, with no build or format check.
  The separate typecheck and lint are what Cellarman's own checks before its end run, as they do in a brew ([ADR 0381](0381-a-brewer-that-writes-code-runs-the-quick-checks-before-its-end-and-is-sent-back-once.md)), and they give the record a reading each; in the green step `npm run check` runs them again, about 17 seconds a round on #855's base.
  The setup installs the base's dependencies in the check step's worktree before its checks ([ADR 0140](0140-a-repository-s-setup-runs-before-a-check-step-s-checks-with-the-network.md)).
  `npm run check` runs the test files the change reaches from `origin/main`, which in the scratch clone is the order's base ([ADR 0241](0241-each-test-runs-at-the-stage-where-it-pays-the-check-runs-the-test-files-a-change-reaches.md)).
  A probe by hand on #855's base found `npm ci`, the typecheck, the lint and `npm run check` all passing there; it is no test.
- **Each run records**, in its record of `results.jsonl`:
  - whether the green step's last attempt passed, and that attempt's readings, one line per check;
  - each step's attempts, as its rounds, and the tokens, turns and time its sessions' receipts give;
  - the commit the green step's last attempt read, Cellarman's code;
  - the models Cellarman's transcripts name;
  - the code's diff from the base, without the files under `test/`.

  A run whose checks failed measured the code all the same.
  A run with no commit the checks read measured nothing: it is listed as failed and brewed once more, as ADR 0332's runs are.
- **A run on a model it did not ask for stops the comparison**, as [ADR 0344](0344-tasting-compare-real-measures-a-stronger-model-and-more-effort-apart.md) has it: an id asks for itself, a family for any id that holds it, and `[1m]` is no part of the name a transcript gives.
  So does a Cellarman whose transcript cannot be found.
- **Its records stay apart**, under `real/brewers`, or `real/comparisons/<name>/brewers` with `--comparison <name>`, away from the Taster setups' records.
  One blinded list per order, `lists/<order>.md`, shows each run's diff under its code, in a fence no line of the diff can close.
  `codes.md` names each code's setup, model, effort, checks, rounds, tokens, turns, the brewers' time and the wall time, and the failed runs.
  The table it prints counts each setup's runs, failed goes, retries and the runs that passed the checks.
  A person scores the lists against #879's key; the program scores nothing.
- **`--dry-run` scripts Cellarman too**: it commits the head's other files as brewed, so a dry run spends no token, while its setup and checks run for real.
- **`--brewer gauger` is not built.**
  A real Gauger needs the red proof after it, which reads a test map ([ADR 0297](0297-the-red-proof-reads-a-test-map-only-and-a-test-first-batch-with-none-is-stuck-before-its-first-step.md)), and no base of the three holds one: it would take a Brewery test map per base, with its fixture and tests.
- **Every existing setup is as it was measured**: its recipe, its Brewery's files, its records and its lists do not change.
- **A Brewery need do nothing:** nothing in one changes, no default brewer's `version` changes, and this runs only by hand in scratch folders.

## Consequences
- No number exists when this record is accepted: the maintainer runs it after the merge, on Sonnet and on Opus, in one comparison, and scores the lists blind against #879's key.
- Cellarman's own checks before its end ([ADR 0381](0381-a-brewer-that-writes-code-runs-the-quick-checks-before-its-end-and-is-sent-back-once.md)), its typecheck and lint, run in its worktree, where the setup does not run, since Cellarman has no shell ([ADR 0163](0163-a-repository-s-setup-runs-before-a-brewer-attempt.md)).
  They read the checkout's `node_modules` above the scratch folder, not the base's, so they may differ from the green step's.
  That is a known limit of the measure, not something to fix here.
- The green step's own time is in no event: a run's time per step is its brewer sessions', and the wall time holds the checks.
- A run brews with the order's issue text, as the Tasters' setups do; the Brewmaster's sub-order as the starting text is #1052's.

## Alternatives considered
- **A named profile per model**, as ADR 0344 and ADR 0348 added: each new model would need code and an ADR, which the M4 evals that test new models per brewer cannot wait for.
- **A test-first recipe with the red proof**: it would need a test map of Foedrum at each base, which no base holds.
- **Tool rules that let Cellarman run the checks itself**, so the setup runs in its worktree: Cellarman would then work with tools the heads were not brewed with.
