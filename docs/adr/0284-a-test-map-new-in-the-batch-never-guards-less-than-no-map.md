# 0284. A test map new in the batch never guards less than no map

Date: 2026-10-31 · Status: Accepted · Amends [0274](0274-the-red-proof-reads-line-coverage-of-the-change-and-a-test-map-not-test-names.md) (what `testsUnchanged` keeps where only the batch's map lists modules)

## Context
[ADR 0274](0274-the-red-proof-reads-line-coverage-of-the-change-and-a-test-map-not-test-names.md) has `testsUnchanged` keep every line the red step added to a separate test file of the map, and drops the `DECLARATIONS` and `ASSERTIONS` lists that [ADR 0078](0078-the-red-proof-reads-the-test-report-and-testsunchanged-compares-lines.md)'s guard reads.
A file in no test area of the map, and a module whose tests are inline, are not guarded mechanically.
Until #708 has a batch's first step propose a map, a repository with no map keeps today's name reading (ADR 0282, from #718), so `testsUnchanged` keeps ADR 0078's declarations and assertions there.
The review of #711 found a gap between the two: where the base has no map, the Gauger can commit one in the same step as its tests, and that map decides alone.
A map that puts the red test files in no test area, or marks their module inline, leaves them unguarded, where no map at all would have kept their declarations and assertions.
The Gauger's output is model text that issue text can steer ([ADR 0041](0041-untrusted-input-in-per-prompt-nonce-tags.md)).

## Decision
- **Where only the batch's map lists modules** (the base has none), the files of the proven step that map guards by no line, in no test area or in an inline module, keep what ADR 0078 keeps: their declarations and assertions, compared against the attempt's diff.
- So a map the brewers under check wrote never guards less than no map does. Where the base has a map, its modules govern as ADR 0274 has them, and this rule does not apply.
- The rule ends with ADR 0078's lists, once #708 makes "no map" no longer happen.

## Consequences
- `changedTestLines` (`src/checks/tests-unchanged.ts`) takes `newMap`, true when the base has no map, and adds `changedTests` for the files it does not guard by line.
- A Gauger that adds a map and its tests cannot leave its tests with less protection than before the map.
- The lists stay in `src/checks/tests-unchanged.ts` until #708 removes them with the no-map case.
