# 0363. A merge brief reads the rounds and the survey of every recipe its batch brewed

Date: 2026-11-10 · Status: Accepted · Amends [0327](0327-a-pass-over-one-batch-s-effects-that-throws-stops-no-other-batch.md) (the brief's rounds and survey read the whole batch, its other lines the current recipe)

## Context
Since [ADR 0327](0327-a-pass-over-one-batch-s-effects-that-throws-stops-no-other-batch.md) (#871), each line of the merge brief reads only the attempts scheduled under the batch's current recipe (`ofCurrentRecipe`).
#972 asked for more: that the brief's rounds (`dispositionLines`) and its survey line (`surveyLines`) read only the batch's latest run of that recipe, so a batch that returned to a recipe would show nothing of its earlier run.

The review of that change found the premise wrong.
A recipe choice leaves the batch's task tree where it was (`batch.recipe_chosen` in `src/engine/fold.ts`), and each attempt starts from it (`attemptStart`, [ADR 0066](0066-the-task-tree-continues-from-the-latest-succeeded-attempt.md)); only a rewind resets it to the commits it names.
So the commits of every run the batch brewed, under any recipe, are on the head the brief is about.
The fixes an earlier run's rounds made are in the pull request, and so is a test map its survey committed.
A later survey reads that map as fresh because it is there.
Hiding them, as ADR 0327's rule already did for an earlier recipe, leaves out of the brief a test map no person has confirmed, though merging the pull request confirms it ([the test map](../design/checks/test-map.md)).

## Decision
The brief reads its evidence about what is on the head from the whole batch: the rounds of each Taster's step and what the steps its routes went back to did with each finding, and the first survey that proposed a map, of every recipe the batch brewed, including an earlier run of the current one.
The steps are listed in the current recipe's order, then the others in the order they first started.
The lines about a step's latest attempt read the current recipe's attempts, as ADR 0327 decided: where the last Taster tasted, its risk left, a Taster's open findings, a step a skip left open, Brett's survivors, the check steps and the steps not run.
`batch.runFrom` and the fold are unchanged.

## Consequences
- A batch moved to another recipe, or back to one it brewed, lists every round that fixed code on its head and reports a map an earlier run committed.
- An earlier recipe's Taster's risk left and verdict stay out of the brief, as before.
- A rewind does not change what the brief reads: rounds whose commits it dropped are still listed, as before #871.
- The brief only reads events already recorded, so a Brewery has nothing to migrate.

## Alternatives considered
- **The latest run only, by a new fold field set at each recipe choice** (#972's option): it hides fixes and a proposed map that are on the head.
- **The current recipe only** (ADR 0327 as it was): the same, for an earlier recipe.
