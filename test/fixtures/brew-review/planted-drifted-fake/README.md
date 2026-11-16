# Planted-defect sample: a fake that drifted from the code it stands in for

A change and the base it is made on, used to check `defaults/lenses/diff/test-design.md` after a prompt changes (CLAUDE.md, Tests), with [planted-empty-passes](../planted-empty-passes/README.md) and [planted-snapshot-only](../planted-snapshot-only/README.md) (#1099).
It is built from `test/helpers/fake-recipes.ts`, whose `mayRetry` still counted every attempt after [ADR 0325](../../../../docs/adr/0325-a-step-counts-its-attempts-per-round.md) made the real recipe count only the current round's.
The files are data: no test applies them.

- `0001`: the base, a tiny repository: `src/retry.mjs` (`mayRetry` counts every attempt), `src/recipe.mjs` (`stepOf` builds a step on it), `src/run-step.mjs`, and `test/helpers/fake-step.mjs`, which stands in for `stepOf` in the runner's tests.
- `0002`: the change: `mayRetry` counts only the current round's attempts and `stepOf` passes the round, with a test of `mayRetry`. The fake still counts every attempt.

Both commits' tests pass.

## Apply

As for [planted-acceptance](../planted-acceptance/README.md#apply), with this folder's patches; the bundle needs no `order.md`.

## Expected findings

| Defect | Expected result |
|---|---|
| `test/helpers/fake-step.mjs:4` counts every attempt, where `src/retry.mjs:4` now counts the current round's | **found**: a finding on the fake's line, introduced, naming the changed rule it no longer matches; the fix reuses the real code |

Findings that may appear and are not wrong: nothing tests `stepOf` (`src/recipe.mjs:5`), so dropping its `round` passes; `mayRetry` with an attempt that has no `round`.

A run that misses the fake means a prompt change made the lens weaker. Compare the run with this table in the pull request that changes the prompt.
