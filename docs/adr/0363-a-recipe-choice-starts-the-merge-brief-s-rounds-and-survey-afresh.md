# 0363. A recipe choice starts the merge brief's rounds and survey afresh

Date: 2026-11-10 · Status: Accepted · Amends [0327](0327-a-pass-over-one-batch-s-effects-that-throws-stops-no-other-batch.md) (the brief reads a batch's latest run of its current recipe, not every attempt with that recipe's name)

## Context
A merge brief reads only the attempts scheduled under its batch's current recipe ([ADR 0327](0327-a-pass-over-one-batch-s-effects-that-throws-stops-no-other-batch.md), `ofCurrentRecipe`).
That check compares recipe names.
A batch that returns to a recipe it brewed before (plain-taste, then when-taste, then plain-taste) keeps the attempts of both runs under that name.
Two lines of the brief read every attempt of a step, not only its latest: the dispositions, through `lensRounds`, and the survey, which takes the first attempt that proposed a map (#972).
So the brief listed run 1's rounds beside run 2's, and reported a map run 1 proposed when run 2's attempt said `fresh`.
The lines that read a step's latest attempt are not reached: run 2 schedules each step again, and the pull request is ready only after run 2's attempt.

The fold could not tell where the latest run began.
`runFrom` is set by a recipe choice and by a rewind ([ADR 0357](0357-after-a-round-back-a-group-runs-again-only-its-every-round-children-and-those-with-findings.md)), and a rewind must keep the attempts of the steps before its point.
The path alone tells it only when an attempt of another recipe started in between.
It cannot tell it when a person chose the same recipe again from Stuck, which `foedrum recipe` allows, or chose another recipe and then the first again before any attempt started.

## Decision
The fold records `recipeFrom`, how many attempts of the batch's path started before its latest `batch.recipe_chosen`, the same recipe's included.
A rewind does not move it.
The brief's rounds and survey read the batch from that point (`ofLatestRun`, `src/engine/merge-brief-post.ts`): its path since then, and only the attempts on it.
Every recipe choice therefore starts a fresh history for the brief.
The status comment still shows the batch's whole path.
Every other line of the brief reads as before.

## Consequences
- A brief no longer lists an earlier run's rounds of a Taster, nor a map an earlier run's survey proposed.
- A rewind within the latest run keeps the rounds of the steps before its point.
- The field is a fold of events already recorded, so an older log folds to the same `recipeFrom`. No Brewery file changes, so a Brewery has nothing to migrate.

## Alternatives considered
- **The boundary from the path alone** (just after the last attempt of another recipe): no new field, but it misses a return to the same recipe from Stuck, and a return through a recipe that started no attempt.
- **`runFrom` as the boundary**: a rewind would drop the rounds of the steps before its point.
