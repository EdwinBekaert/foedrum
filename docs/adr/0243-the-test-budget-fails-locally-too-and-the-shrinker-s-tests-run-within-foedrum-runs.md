# 0243. The test budget fails locally too, and the shrinker's tests run within `FOEDRUM_RUNS`

Date: 2026-10-27 · Status: Accepted · Amends [0136](0136-the-test-budget-fails-only-in-ci.md) (the budget and the ceiling fail outside CI too, after the runs alone of ADR 0089)

## Context
`npm test` holds each file in `test/unit/` to 5 s of CPU time and each file in `test/property/` and `test/chaos/` to a ceiling of 15 s ([ADR 0036](0036-test-budget-in-cpu-time.md)).
A file over its limit in the run is run again alone, up to three times, and the lowest reading counts ([ADR 0089](0089-a-file-over-the-test-budget-is-measured-again-alone.md)).
Since [ADR 0136](0136-the-test-budget-fails-only-in-ci.md) that fails only in CI: outside it, a file over its limit is listed in the times and fails nothing.

The chaos and property files read their run count from `FOEDRUM_RUNS`: a few in `npm run check`, 200 and 500 on CI's Linux leg per pull request, 1,000 on every leg at night ([ADR 0033](0033-chaos-tests-effects-found-by-key-and-leases-at-start.md), [ADR 0134](0134-the-red-proof-runs-once-the-review-drops-its-coverage-delta-and-property-and-chaos-run-on-one-leg-per-pull-request.md)).
`test/chaos/shrink.test.ts`, the shrinker's own tests ([ADR 0061](0061-chaos-faults-at-sites-shrinking-worktrees-and-the-state-branch.md)), did not.
It searched up to 30 seeds for each planted failure, shrank it from the forty moves a chaos run plays, ran every step of the smallest schedule's proof, and replayed a dozen seeds or more, whatever `FOEDRUM_RUNS` said.
It used 20 s of CPU time on a laptop and 9-12 s alone on a desktop, over the ceiling on the one and close to it on the other, and nothing stopped it: in CI, where it used 4.7-7.9 s, it was within the ceiling, and outside CI the ceiling fails nothing (#596).
Most of its time went to one shrink: the first two-driver run that took a batch over from a killed driver (seed 2) holds 21 faults, and shrinking it replays the run 139 times.

The reason for ADR 0136 was load: several sessions on one machine pushed files over their limit with nothing wrong in them, and their load could outlast all three runs alone.
Two things changed since.
CPU time hardly moves with load once a file runs alone, and the runs alone come after the run, when its own files no longer load the machine.
And with ADR 0241 (#595) the gate runs only the test files a change reaches, and CI all of them, so the run behind a local reading is far smaller than the whole suite beside three other check steps.

## Decision
- **The budget and the ceiling fail outside CI too.** A file over its limit in the run is run again alone as [ADR 0089](0089-a-file-over-the-test-budget-is-measured-again-alone.md) has it (up to three times, starting runs for 90 s, the lowest reading counting) and fails `npm test` when it is over alone too; a file within it alone passes with its `ℹ` line, in CI or not. The reporter no longer reads `CI`: its `ci` option and `runsInCi` go, since nothing else read them.
- **`shrink.test.ts` runs within `FOEDRUM_RUNS`.** It reads its count through `runsIn` in `test/helpers/property.ts`, which `FOEDRUM_RUNS` sets with the same parsing and the same refusal of a mistyped number as every other property and chaos file, and gives 3 when it is unset. From a dozen on (CI's 200 and 1,000) the file runs in full, as before: failures found and shrunk in forty-move runs, and a replay of the dozen seeds and more until every kind of fault showed. Below a dozen, as in `npm run check`:
  - **The seeds searched stay** (up to 30, stopping at the first failure): the search is what finds each planted failure, and it costs one run per seed.
  - **A run plays twelve moves instead of forty.** The first two-driver failure then holds fewer faults to shrink (79 runs instead of 139, each shorter), the first kill after an effect is found at seed 13 with four faults, and both still fail as planted. Each check proves what it did: moves and faults are removed down to the ones the failure needs, each fault at its site, and the smallest schedule's proof runs in full (the schedule fails again, and fails no more without any one move or fault, or with any one play a success).
  - **The replay plays the last `runs` of the dozen seeds** (10, 11 and 12 in the check), until every kind of fault showed. Seed 10 is the first whose pauses change what the drivers do, so a replay that dropped them still fails in the check; and seed 10 alone holds every kind of fault.

  It uses 3.7-6.6 s of CPU time alone with coverage on a desktop, against 9-12 s before.
- **Every chaos and property file is within its ceiling** at the check's run count; the measurement is in the pull request (#596). A file over it gets a lower count in its own file.
- **Where the full counts run** stays as [ADR 0134](0134-the-red-proof-runs-once-the-review-drops-its-coverage-delta-and-property-and-chaos-run-on-one-leg-per-pull-request.md) has it: chaos ×200 and property ×500 on the Linux leg per pull request (22 s and 15 s, off the critical path, which is Windows' integration step), ×1,000 on every leg at night. "A few runs in pull request CI" means `npm run check`'s counts, on every leg.

## Consequences
- A file that grew costly fails on the machine where it grew, at the gate, one push before CI would.
- A file over its limit in a local run now costs up to three runs alone, at most 90 s of starts, as in CI; a local run with no file over is no slower.
- Load that outlasts the runs alone can still fail a local run; the reading then names the run's and the run alone's CPU time, and a rerun on a quieter machine tells the two apart. If that happens often, a new ADR weighs it against what this one catches.
- `npm run check` runs the shrinker on shorter runs and fewer replay seeds; a bug that shows only in forty-move runs or on the first nine replay seeds shows on the Linux leg of the same pull request.

## Alternatives considered
- **Keep the budget CI-only:** a file over its ceiling locally never stopped; `shrink.test.ts` used 20 s on a laptop for weeks.
- **Raise the ceiling:** it would stop catching a run count grown too large, which is what it is for.
- **Fail only at the gate:** the gate runs `npm run check` on the same machine, so its reading is the same one; a run outside the gate would only see the failure later.
- **Move `shrink.test.ts` out of `test/chaos/`:** it would drop out of every check, the Linux leg's included.
- **A CI path trigger for `test/helpers/chaos*`:** a change there already reaches every chaos file in ADR 0241's affected set, and the Linux leg's `FOEDRUM_RUNS` runs the shrinker in full.
- **Fewer seeds searched in the check:** the search stops at the first failure, so a lower limit saves nothing until it misses the planted failure.
- **Fewer steps of the smallest schedule's proof in the check:** they are a tenth of the two-driver test's runs; dropping some would prove less and save little.
