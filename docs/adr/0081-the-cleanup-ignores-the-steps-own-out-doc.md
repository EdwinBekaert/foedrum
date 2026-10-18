# 0081. The cleanup ignores the step's own out doc

Date: 2026-10-18 · Status: Accepted · Amends [0029](0029-attempt-worktrees-layout-claims-and-repair.md) (what keeps a worktree with changes) and [0037](0037-attempt-worktrees-in-the-engine-and-driver-locks.md) (what a cleanup is given)

## Context
[ADR 0029](0029-attempt-worktrees-layout-claims-and-repair.md) keeps every attempt worktree with uncommitted or untracked changes: they may be someone's work. The out doc contract tells every brewer to write its out doc (`output.doc`, such as `brew.md`) in its worktree, and nothing commits it. So every attempt that finished leaves one untracked file, and the first live run of `foedrum serve` kept every worktree of a batch on tap (#197): `kept worktree 2-1/brew/2: it has uncommitted or untracked changes`. The work root grows with each batch.

The out doc could also be written outside the worktree, next to the attempt's settings file. But the brewer's sandbox and file-tool rules allow writes only inside its worktree, and a later step reads an earlier step's out doc from that step's worktree (`inputsOf`, `src/brewers/attempt-plan.ts`), with the runner's reader refusing anything outside it. Both would have to reach outside the worktree.

## Decision
- **The out doc stays in the worktree, and the cleanup ignores exactly the step's own out doc.** A worktree whose only change is its untracked out doc counts as clean: the cleanup deletes that one file, then removes the worktree with plain `git worktree remove`, which still refuses any other change. Anything else keeps the worktree, as before: another untracked file, a changed tracked file, or a tracked file of the out doc's name that the brewer changed.
- `output.doc` is a `PathSafeId`, one path segment, so the out doc is one file at the top of the worktree, and `git status --porcelain` names it as `?? <out doc>`. Only that exact line counts; a name in other case, or an untracked folder, does not.
- **Its name comes from the brewer of the attempt's step**, in the recipe its batch brews: the lookup the runner's limits used (`AttemptPlans.outDoc`). The engine puts it in the claims of an ended batch's steps (`Claims.outDocs`, by `<batchId>/<stepId>`), which a worktree of that step's folder is checked against. An attempt that resumed a session runs in the worktree of an attempt of the same step, so the step names its out doc too. When no brewer is found (a check step, a recipe changed since), nothing is ignored and the worktree is kept.
- The cleanup of a live batch, `create` and `recreate` read a worktree's state as before: a reused worktree with an out doc is not clean.

## Consequences
- A batch that goes on tap with everything committed leaves no attempt worktree behind.
- The out doc's body goes with the worktree. The engine has its frontmatter (the outcome in `step.finished`), but the state branch does not keep out docs yet (`writeOutDoc` has no caller), so until it does, the body of an ended batch's out doc is gone once its worktree is.
- Between the status read and `git worktree remove`, a new change makes git refuse: the worktree is kept and reported, without its out doc. Nothing runs in a worktree of an ended batch without a live lease, so this needs a process outside Foedrum.
- A brewer that commits its out doc still puts it in the pull request; that is the brewer's instructions' business, not the cleanup's.

## Alternatives considered
- **Write the out doc outside the worktree, next to the attempt settings:** the cleanup would need no exception, and a brewer could not commit it by mistake. But the sandbox and the file-tool rules would allow a path outside the worktree, and the reader of out docs and of a later step's inputs would move with it: a wider change to a security boundary for a cleanup fix.
- **Delete the out doc once the runner read it:** the cleanup would stay as it is, but a later step reads that out doc from the worktree as its input.
- **Record the out doc's name in `step.started`:** exact even when the recipe changes, but a new event field and schema for a name the brewer lookup already gives; a lookup that misses keeps the worktree, which is safe.
- **Ignore every untracked file of an ended batch:** simpler, but removes what a human or a brewer left uncommitted, which ADR 0029 keeps on purpose.
