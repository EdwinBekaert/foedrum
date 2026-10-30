# 0260. An attempt's out doc comes from the recipe it was scheduled under

Date: 2026-10-30 · Status: Accepted · Amends [0081](0081-the-cleanup-ignores-the-steps-own-out-doc.md) (where the out doc's name is found, and the key of `Claims.outDocs`)

## Context
ADR 0081 lets the cleanup remove a worktree whose only change is its step's untracked out doc.
It finds the out doc's name through the brewer of the step "in the recipe its batch brews", and accepted that a step a recipe change left behind keeps its worktree.
That case is not rare: every `foedrum mash` batch has it.
Its Innkeeper's step runs under `mash` ([ADR 0232](0232-foedrum-mash-routes-an-issue-to-the-innkeeper-whose-question-the-answer-chooses-the-recipe-by.md)), and the mash-in answer chooses the recipe the batch then brews, which has no `innkeep` step.
So `mash-in.md` is not recognised, and every mash batch keeps its innkeep worktree when it ends (#657):

```
kept worktree 12-1/innkeep/1: it has uncommitted or untracked changes
```

The same happens after any `foedrum recipe` change, for each step the new recipe lacks.
The fold keeps only the batch's latest recipe (`batch.recipe_chosen`), so the recipe a step ran under was not known once the batch had moved on.

## Decision
- **The fold records the recipe on each attempt.** At `step.scheduled`, the attempt gets the name of the recipe its batch brews then (`Attempt.recipe`, absent while the batch has none). It is a fact the fold already has at that event, so no event field is added, and a log written before this decision folds to attempts that carry it too.
- **An attempt's out doc comes from the brewer of its step in that recipe** (`AttemptPlans.outDoc`, given the attempt), and from the batch's recipe for an attempt that recorded none.
- **`Claims.outDocs` is keyed by attempt**, `<batchId>/<stepId>/<attempt>`, for every attempt of an ended batch. A worktree is checked against the out doc of the attempt that made it, which is its folder's attempt: an attempt that resumes a session runs in that worktree ([ADR 0117](0117-a-retry-resumes-the-session-of-the-attempt-before-it-in-that-attempt-s-worktree.md)).
- The rest of ADR 0081 stands: only that one untracked file is ignored, plain `git worktree remove` still refuses any other change, and a step without a brewer, such as a check step, ignores nothing.
- `limits` and `prepare` keep finding the brewer in the batch's current recipe. They run for the attempt being scheduled or started, whose recipe is the current one.

## Consequences
- A mash batch's innkeep worktree, and the worktree of any step a recipe change left behind, goes with its out doc when the batch ends.
- A step id that two recipes share, run under both, gets each attempt's out doc from its own recipe, so a worktree is not kept because the later recipe gives the step another brewer.
- The `Attempt` type gets an optional field; whatever compares whole attempts sees it.

## Alternatives considered
- **Search the batch's recipe history:** the fold keeps no history, and adding one is a larger change for the same fact.
- **Search every recipe of the Brewery for the step id:** a guess. Two recipes may give the same step id different brewers.
- **Record the out doc's name in `step.started`:** ADR 0081 rejected it as a new event field for a name the brewer lookup gives. It still is.
- **Keep the key per step, from the latest attempt's recipe:** simpler, but a step run under two recipes would keep the older attempt's worktree when their out docs differ.
