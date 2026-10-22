# 0136. The test budget fails only in CI

Date: 2026-10-22 · Status: Accepted · Amends [0036](0036-test-budget-in-cpu-time.md) and [0089](0089-a-file-over-the-test-budget-is-measured-again-alone.md) (outside CI a file over the budget or the ceiling is reported, not failed, and not run alone)

## Context
`npm test` fails when one test file uses more CPU time than its budget (5 s in `test/unit/`) or its ceiling (15 s in `test/property/` and `test/chaos/`), even when every test passed (ADR 0036). CPU time grows with the machine's load, so a file over the limit in the run is run again alone up to three times and the lowest reading counts (ADR 0089).

On a developer's machine several sessions run at once, and their load can outlast all three runs alone. On 2026-10-22 the budget failed gate checks in several sessions with no slow test at all, each passing on a rerun. A false failure stops a push and costs a full rerun of `npm run check`.

The safeguard audit of 2026-10-22 asked who needs the budget to fail. It exists to stop a file that grew costly from reaching `main`, and CI runs `npm run check` on every pull request on three platforms (docs/trust-boundaries.md: "Bad code reaching `main`"), on runners no other session shares. A local failure catches the same file one push earlier, at the price of failing at random under load.

## Decision
- **Outside CI** (`CI` unset or empty, as `scripts/below-normal-priority.ts` reads it), a file over the budget or the ceiling is listed in the "test file times" block, after the costliest files, with the reading and the limit's advice and the words `it fails only in CI (ADR 0136)`, and does not fail `npm test`. It is not run alone: the runs alone only decide whether the file fails, and they would add up to 150 s to a run for a line in a report.
- **In CI** the budget and the ceiling fail as before, after the runs alone of ADR 0089. Those stay: in CI `npm test` still runs its files beside each other and beside the check's other steps, the load ADR 0089 found matters most, so they are not there only for local runs.
- `runsInCi` in `scripts/test-budget-reporter.ts` reads the environment; `npm test`'s reporter passes it as the reporter's `ci` option, which is true by default, so a reporter built without it fails as before.

## Consequences
- Load from other sessions no longer fails `npm test`, `npm run check` or the gate. A file over its limit shows in the times block of every local run, so a session still sees it before CI does.
- A file that really grew costly now fails first in CI, one push later than before; the pull request cannot merge until it is fixed, since `ci-ok` is required.
- A local run with a file over its limit is no slower than one without: nothing runs alone.
- A session that runs `npm test` with `CI` set (to reproduce CI) gets CI's behaviour, runs alone included.

## Alternatives considered
- **Raise the budget again, or add a fourth run alone:** the load of other sessions has no upper bound, so any number still fails at random.
- **Report locally but still run the file alone, for a closer reading:** costs up to 150 s per run for a line nobody acts on locally; CI gives the reading that counts.
- **Drop the budget:** it would no longer stop a costly file anywhere; the CI runner is where it can be measured without other sessions.
