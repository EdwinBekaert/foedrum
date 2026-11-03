# 0309. The attempt plans find every brewer in the recipe its attempt was scheduled under

Date: 2026-11-03 · Status: Accepted · Amends [0059](0059-attempt-plans-from-the-brewer-of-the-step.md) (the shell finds the brewer in the batch's recipe), [0260](0260-an-attempt-s-out-doc-comes-from-the-recipe-it-was-scheduled-under.md) (`limits` and `prepare` in the batch's current recipe), [0265](0265-foedrum-resume-finds-a-finished-attempt-s-brewer-in-the-recipe-it-was-scheduled-under.md) (the same rule, restated), [0305](0305-a-step-input-of-a-step-the-recipe-lacks-is-left-out.md) (both lookups in the batch's recipe)

## Context
Since [ADR 0260](0260-an-attempt-s-out-doc-comes-from-the-recipe-it-was-scheduled-under.md), each attempt records the recipe its batch brewed when it was scheduled, and `attemptRecipeOf` gives it ([ADR 0265](0265-foedrum-resume-finds-a-finished-attempt-s-brewer-in-the-recipe-it-was-scheduled-under.md)).
ADR 0260 kept `limits` and `prepare` on the batch's current recipe, because "they run for the attempt being scheduled or started, whose recipe is the current one".
That is not so when a person chooses another recipe (`foedrum recipe`, [ADR 0240](0240-order-and-recipe-work-by-the-brewery-issue-on-both-surfaces.md)) after an attempt was scheduled and before it is planned: its limits and its plan then come from a brewer of a recipe it was never scheduled under.
The attempt plans also named the out doc of an earlier attempt, which a `step:<id>` input, the `plan` input or a route reads ([ADR 0128](0128-an-attempt-a-route-schedules-gets-what-sent-it-back.md)), by the brewer of the batch's current recipe.
After a recipe change that file name belongs to the new recipe's brewer, which never wrote in that attempt's worktree (#786).
[ADR 0305](0305-a-step-input-of-a-step-the-recipe-lacks-is-left-out.md) read both its lookups in the batch's recipe, and named this as #786.

## Decision
- **An attempt's own brewer comes from the recipe it was scheduled under**: its `limits` and its plan alike, through `attemptRecipeOf`.
- **An earlier attempt's out doc is named by the brewer of the recipe that attempt was scheduled under**: for a `step:<id>` input, the step's latest succeeded attempt, whose worktree it reads; for the `plan` input, the attempt that wrote the batch's latest plan; for a route, the attempt that sent the step back.
- **Whether the recipe has a step (`StepBrewers.has`, ADR 0305) asks the planned attempt's recipe**, since an input is left out by the recipe this attempt brews; so does the brewer lookup of a `step:` input whose step has no succeeded attempt yet, which still tells a step of no brewer from one with no out doc yet.
- Each falls back to the batch's recipe for an attempt that recorded none, as `attemptRecipeOf` does.
- Only the attempt plans change here; the engine's own lookups of a step in the batch's recipe, which decide what the batch schedules next, stay as they are.
- When the recipe an earlier attempt ran under no longer gives its step a brewer (the Brewery removed or changed that recipe), the input fails as a step of no brewer does; it is never read under the current recipe's file name, which that attempt did not write.

## Consequences
- A batch moved to another recipe midway plans its next steps from the out docs its earlier steps actually wrote.
- An attempt scheduled before a recipe change runs with the brewer, and the limits, of the recipe it was scheduled under.
- A batch that never changed recipes plans as before.
