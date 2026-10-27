# 0243. The shrinker's tests run within `FOEDRUM_RUNS`

Date: 2026-10-27 · Status: Accepted

## Context
`npm test` holds each file in `test/unit/` to 5 s of CPU time and each file in `test/property/` and `test/chaos/` to a ceiling of 15 s ([ADR 0036](0036-test-budget-in-cpu-time.md)).
A file over its limit in the run is run again alone, up to three times, and the lowest reading counts ([ADR 0089](0089-a-file-over-the-test-budget-is-measured-again-alone.md)).
That fails only in CI ([ADR 0136](0136-the-test-budget-fails-only-in-ci.md)): outside it, a file over its limit is listed in the times and fails nothing.

The chaos and property files read their run count from `FOEDRUM_RUNS`: a few in `npm run check`, 200 and 500 on CI's Linux leg per pull request, 1,000 on every leg at night ([ADR 0033](0033-chaos-tests-effects-found-by-key-and-leases-at-start.md), [ADR 0134](0134-the-red-proof-runs-once-the-review-drops-its-coverage-delta-and-property-and-chaos-run-on-one-leg-per-pull-request.md)).
`test/chaos/shrink.test.ts`, the shrinker's own tests ([ADR 0061](0061-chaos-faults-at-sites-shrinking-worktrees-and-the-state-branch.md)), did not.
It searched up to 30 seeds for each planted failure, shrank it from the forty moves a chaos run plays, ran every step of the smallest schedule's proof, and replayed a dozen seeds or more, whatever `FOEDRUM_RUNS` said.
It used 20 s of CPU time on a laptop and 8.9-11.7 s alone with coverage on a desktop, and nothing stopped it: in CI, where it used 4.7-7.9 s, it was within the ceiling, and outside CI the ceiling fails nothing (#596).

Most of its time went to one shrink.
A probe of seeds 1 to 30 found the first two-driver run that took a batch over from a killed driver at seed 2, with 21 faults: shrinking it replays the run 139 times.
The first run with a kill after an effect reached the code host is seed 4, with 2 faults, and shrinks in 24 runs.
The replay's two runs per seed cost 30-160 ms each, and seed 10, the first whose pauses change what the drivers do, holds every kind of fault.

## Decision
`shrink.test.ts` reads its count through `runsIn` in `test/helpers/property.ts`, which `FOEDRUM_RUNS` sets with the same parsing and the same refusal of a mistyped number as every other property and chaos file, and gives 3 when it is unset.

From a dozen on (CI's 200 and 1,000) the file runs in full, as before: failures found and shrunk in forty-move runs, and a replay of the dozen seeds and more until every kind of fault showed.
Below a dozen, as in `npm run check`:
- **The seeds searched stay** (up to 30, stopping at the first failure): the search is what finds each planted failure, and it costs one run per seed.
- **A run plays twelve moves instead of forty.** The first two-driver failure (seed 2) then shrinks in 79 shorter runs instead of 139, and the first kill after an effect is seed 13, with 4 faults, shrinking in 24 runs; both still fail as planted. Each check proves what it did: moves and faults are removed down to the ones the failure needs, each fault at its site, and the smallest schedule's proof runs in full (the schedule fails again, and fails no more without any one move or fault, or with any one play a success).
- **The replay plays the last `runs` of the dozen seeds, and seeds 10 to 12 at least** (10, 11 and 12 in the check), until every kind of fault showed. Seed 10 is always among them, so a replay that dropped the pauses still fails at any count.

The file then uses 3.7-6.6 s of CPU time alone with coverage on the desktop, and 9.9 s with `FOEDRUM_RUNS=200`.
Every other chaos and property file uses 0.7-3.6 s alone there, at the check's count; the four other files with a fixed search of 30 seeds (`kills`, `drivers`, `state-branch`, `worktrees`) are among them and keep it.

The budget and the ceiling keep failing in CI only, as ADR 0136 has them. Decided by the maintainer (2026-10-27), on this measurement of the alternative below: with the budget and the ceiling failing outside CI too, on the desktop shared with other sessions, `npm test` took 339 s and failed with every test passing. `test/unit/serve.test.ts`, untouched, used 11.1 s of CPU time in the run and 9.0 s alone. Three more unit files over the budget in the run were never run alone, since the runs alone had used their 90 s, and `npm run check` timed out twice at its step's 300 s. CPU time alone still moves with load there, which is ADR 0136's reason. The local rule is measured again on the laptop (#604) once ADR 0241 (#595, not merged when this was written) has the gate run only the test files a change reaches.

Where the full counts run stays as ADR 0134 has it: chaos ×200 and property ×500 on the Linux leg per pull request (22 s and 15 s, off the critical path, which is Windows' integration step), ×1,000 on every leg at night.

## Consequences
- `shrink.test.ts` stays within the ceiling in `npm run check` on the desktop it was measured on after the change, with room for the shrinker to grow.
- `npm run check` runs the shrinker on shorter runs and fewer replay seeds; a bug that shows only in forty-move runs, or only on seeds 1 to 9 of the replay, shows on the Linux leg of the same pull request.
- A file over its ceiling locally still only shows in the times block; it stops in CI.

## Alternatives considered
- **Fail the budget and the ceiling outside CI too, after the runs alone:** measured above; it failed `npm test` with nothing wrong, and its runs alone pushed the check past its time.
- **Raise the ceiling:** it would stop catching a run count grown too large, which is what it is for.
- **Move `shrink.test.ts` out of `test/chaos/`:** it would drop out of every check, the Linux leg's included.
- **A CI path trigger for `test/helpers/chaos*`:** the Linux leg's `FOEDRUM_RUNS` runs the shrinker in full on every pull request, and with ADR 0241 (#595) a change there also reaches every chaos file in the gate's affected set.
- **Fewer seeds searched in the check:** the search stops at the first failure, so a lower limit saves nothing until it misses the planted failure.
- **Fewer steps of the smallest schedule's proof in the check:** they are about a tenth of the two-driver test's runs; dropping some would prove less and save little.
