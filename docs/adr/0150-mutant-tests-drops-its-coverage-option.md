# 0150. mutant-tests drops its coverage option

Date: 2026-10-22 · Status: Accepted · Amends [0134](0134-the-red-proof-runs-once-the-review-drops-its-coverage-delta-and-property-and-chaos-run-on-one-leg-per-pull-request.md) (`scripts/mutant-tests.ts --coverage` goes) and [0054](0054-test-runs-below-normal-priority-and-review-runs-scoped-to-the-question.md) (the script selects the mutation check's tests only)

## Context
[ADR 0134](0134-the-red-proof-runs-once-the-review-drops-its-coverage-delta-and-property-and-chaos-run-on-one-leg-per-pull-request.md) took the coverage delta out of `/brew-review` and kept `scripts/mutant-tests.ts --coverage` "for a coverage run by hand". Nothing calls it: the review no longer does (#361), no script or skill names it, and `npm test` already fails below the coverage thresholds for the whole suite. The option kept about 50 lines of code (`coveringTestsFor`: a walk over the imports at any depth, and a reader of test file strings) and 80 of tests alive for a run nobody makes.

## Decision
- **`--coverage` goes** from `scripts/mutant-tests.ts`, with `coveringTestsFor` in `scripts/mutant-tests/core.ts` and their tests. The script prints the mutation check's tests only: the files in `test/unit/`, `test/property/` and `test/chaos/` that import a given file directly or through one module (ADR 0054). Its line in `CLAUDE.md` says so.
- A coverage run by hand runs `npm test`, or `node --test --experimental-test-coverage` on the files `grep -l <module> test/` names.

## Consequences
- `node scripts/mutant-tests.ts --coverage …` now fails as an unknown option, from `parseArgs`.
- The review's mutation check (stage 4) is unchanged: it never passed the option.

## Alternatives considered
- **Keep it for a later coverage tool.** Code nobody runs drifts from the tests it would select; a later need can write the walk again against the tree it has then.
