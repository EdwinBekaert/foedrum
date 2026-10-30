# 0258. A Gauger its red proof sent back may name its tests without a commit

Date: 2026-10-30 · Status: Accepted · Amends [0074](0074-git-commit-grants-fixed-git-rules-and-done-needs-a-commit.md) (a `gauge` out doc's `done` that names its tests needs no commit in a round a failed red proof of its step sent back), [0170](0170-the-red-proof-accepts-the-regression-tests-a-gauger-names.md) (the names such a `done` gives are the ones the next red proof reads)

## Context
A `done` of a brewer that produces commits needs a commit after its worktree's start, or its batch goes Stuck on a divergence ([ADR 0074](0074-git-commit-grants-fixed-git-rules-and-done-needs-a-commit.md)); a Finer that says `unchanged` is the one exception ([ADR 0166](0166-the-finer-simplifies-a-batch-s-change-before-green.md)).
The red proof reads the tests a step named in the out doc of its latest succeeded attempt, and finds the step's tests in that attempt's commits ([ADR 0170](0170-the-red-proof-accepts-the-regression-tests-a-gauger-names.md), ADR 0078).
In a live Nip run (#660, Brewery batch 12-2), the Gauger's first attempt committed 17 tests but named none, so the red proof failed on nine passing tests and sent the batch back to the Gauger: its seven control tests, which pass before the change, and two existing tests named `array`, which the `"type": "array"` its regenerated `schemas/event.json` adds reads as declared (#661).
The second attempt rightly found the committed tests right and only named them: with no commit, it was blocked as a divergence.
A `retry` runs a Gauger that again has nothing to commit, and a `skip` runs the red proof on the first attempt's empty names: no way on.

## Decision
- **A Gauger a failed red proof of its step sent back may end `done` without a commit when it names its tests.**
  `settleAttempt` settles such a `done`, with a non-empty `tests` or `regressionTests` and no commit since the start, as a success; the red proof then reads its names, and its commits are the earlier attempts' ([ADR 0170](0170-the-red-proof-accepts-the-regression-tests-a-gauger-names.md)), since its worktree started at their tip.
- **Every other `done` without a commit is still ADR 0074's divergence**: a Gauger that names no test, one no red proof sent back, and any other brewer.
- **The engine reads the facts, not the out doc**: the attempt's limits carry `namesOnly` when the brewer's out doc schema is `gauge`, the schema and not the brewer's name, and the route that started the attempt's round is a `failed` route from the check step that proves this step red (`proves` of the recipe's checks).
  A retry or an answer starts as the attempt before it (ADR 0117, ADR 0118), so it is in that attempt's round, and `roundRouteOf` (`src/engine/fold.ts`) reads the route back through them, as the merge at an attempt's start does ([ADR 0244](0244-a-conflict-with-the-moved-base-sends-its-batch-back-to-the-fix-step.md)).
  So `foedrum retry` of a batch Stuck on such a divergence, whose retry carries no route of its own, runs a Gauger that may name its tests.
- **Not decided here**: a Gauger that commits tests and names none is not failed by the runner.
  The red proof finds new tests by their declarations, so only regression tests must be named, and it already sends a missing name back with its reason; such a rule would also fail the demo's scripted Gauger, which names none.

## Consequences
- Batch 12-2 can go on: `foedrum retry 12-2` resumes the Gauger's second session, whose `done` with its names now succeeds, and the red proof runs on them.
- A Gauger sent back with nothing to change no longer needs an empty commit to be read.
- The rule lives in `doneWithCommits` (`src/engine/brewer-runner.ts`), next to the Finer's, and in `attemptLimits` and the attempt plans' `limits`.
