# 0265. `foedrum resume` finds a finished attempt's brewer in the recipe it was scheduled under

Date: 2026-10-30 · Status: Accepted · Amends [0126](0126-foedrum-resume-opens-a-finished-attempt-s-session-in-its-worktree.md) (the recipe the brewer is found in)

## Context
ADR 0126 writes a resumed attempt's settings again "from the brewer of the step in the batch's recipe", so that they hold what the brewer's attempt had.
That was the same recipe while a batch kept one recipe for its whole life.
It is not after a recipe change: a `foedrum mash` batch runs its `innkeep` step under `mash`, and the mash-in answer chooses the recipe the batch then brews ([ADR 0232](0232-foedrum-mash-routes-an-issue-to-the-innkeeper-whose-question-the-answer-chooses-the-recipe-by.md)), which has no `innkeep` step.
So `foedrum resume 12-1 innkeep` failed with `recipe pale has no step innkeep` (#670), and the same held for any step a `foedrum recipe` change left behind.
Since [ADR 0260](0260-an-attempt-s-out-doc-comes-from-the-recipe-it-was-scheduled-under.md), the fold records on each attempt the recipe its batch brewed when it was scheduled (`Attempt.recipe`).

## Decision
- **`foedrum resume` finds a finished attempt's brewer in the recipe that attempt was scheduled under**, and in the batch's recipe for an attempt that recorded none, as ADR 0260 does for the out doc. The settings, the engine's rules beside them and the command line come from that brewer.
- One function of the fold gives that recipe (`attemptRecipeOf`), for resume and for the attempt plans' out doc alike.
- The rest of ADR 0126 stands, and so does ADR 0260's rule that `limits` and `prepare`, which run for the attempt being scheduled or started, use the batch's current recipe.

## Consequences
- A step a recipe change left behind resumes with the brewer it ran with, unless the Brewery's files changed since, as ADR 0126 already allows.
- A step id that two recipes share, run under both, resumes each attempt with the brewer of its own recipe.

## Alternatives considered
- **Keep the batch's recipe:** the brewer would be missing, or another brewer with the same step id, so the session would not get the settings it had.
- **Search every recipe of the Brewery for the step id:** a guess, rejected in ADR 0260 for the same reason.
