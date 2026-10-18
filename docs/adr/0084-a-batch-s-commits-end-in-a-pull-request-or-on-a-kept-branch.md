# 0084. A batch's commits end in a pull request or on a kept branch

Date: 2026-10-18 · Status: Accepted · Amends [0053](0053-recipe-files-reach-the-engine-brewer-steps-in-a-line-first.md) (what loads), [0059](0059-attempt-plans-from-the-brewer-of-the-step.md) (on tap without a pull request), [0029](0029-attempt-worktrees-layout-claims-and-repair.md) and [0081](0081-the-cleanup-ignores-the-steps-own-out-doc.md) (what the cleanup of an ended batch deletes)

## Context
[ADR 0059](0059-attempt-plans-from-the-brewer-of-the-step.md) lets a recipe without the `openPullRequest` action put its batch on tap without a pull request. The cleanup of an ended batch ([ADR 0029](0029-attempt-worktrees-layout-claims-and-repair.md), [ADR 0081](0081-the-cleanup-ignores-the-steps-own-out-doc.md)) then removes its attempt worktrees and deletes their branches. Nothing pushed the task tree ([ADR 0066](0066-the-task-tree-continues-from-the-latest-succeeded-attempt.md)), so the branch of its attempt was the only ref to the brewers' commits. In the live demo of 2026-10-18 (#221) the `stout` recipe, one step of a brewer that produces commits, went on tap with no pull request, `serve` deleted `foedrum/3-1/brew/4`, and `git fsck` found the commit dangling, for `git gc` to drop. Nothing warned anyone.

A cancelled batch is in the same place: it ends before its pull request, and its commits went with its branches.

## Decision
- **A recipe with a step whose brewer produces commits must end with `{ "action": "openPullRequest" }`.** `loadRecipes` refuses it otherwise, one line per such step, naming the fix: `recipes/stout.jsonc: step "brew" has the brewer "cellarman", which produces commits, and no step opens a pull request with them: end the recipe with { "action": "openPullRequest" } (ADR 0084)`. Nested steps (a loop's, a session's fallback) count, as for the red proof ([ADR 0064](0064-test-first-recipes-when-onblocked-and-a-red-proof-required.md)). A recipe whose brewers commit nothing (a review, a triage) still goes on tap without a pull request, as ADR 0059 says.
- **The cleanup never deletes the only ref to an ended batch's task tree.** The engine's claims name, for each ended batch whose task tree is an attempt's branch and whose ledger has no push from that branch, the branch and the commit the batch started from (`Claims.unpushed`; the start is the commit of the worktree of the batch's first attempt that succeeded in that repository, made at the base; an attempt that failed before it may have started at a base that moved since). `planClean` keeps that branch while its tip is not the start, with the line `kept branch <branch>: it holds the task tree of batch <id>, which no push recorded (ADR 0084)`, as it keeps a worktree with changes. Its worktree still goes; the other attempt branches of the batch go as before.
- A push the ledger recorded from another revision does not count: the task tree moved since (a rewind and more attempts after it), so its branch holds commits no push has.

## Consequences
- A batch's commits end in a pull request or on a branch that stays. The cases the refusal does not cover keep the branch: a recipe loaded before this rule, a cancel, an `openPullRequest` skipped by its `when`, or an action that failed and left the batch Stuck, then cancelled.
- A kept branch stays until someone deletes it (`git branch -D` in the clone, after taking the commits). Nothing reminds anyone of it yet beyond the cleanup's line, which `foedrum serve` prints.
- A rewound task tree is a commit, not a branch, so it names nothing to keep: the commits of a rewind come from an earlier attempt's branch, which the cleanup deletes as before. That gap is narrower than #221's, since a rewind starts from a Stuck batch a human looks at, and it is left for when rewinds reach the clone.
- The intermediate attempt branches of a batch go even when its task tree's branch is kept: the task tree's branch holds their commits, since each attempt starts at the one before it (ADR 0066).
- `foedrum serve`'s tests and the integration tests that brew a committing recipe now end it with the action, and those without a code host go Stuck at that step.

## Alternatives considered
- **Only the refusal:** states the rule, but a recipe loaded before it, a cancel or a skipped action still loses the commits.
- **Only the cleanup rule:** guards the work whatever the recipe does, but lets a recipe go on tap with commits nobody will see, leaving branches that pile up in the clone.
- **Keep every branch of an ended batch that no push recorded:** simpler, but keeps a branch of every review or triage batch too, whose brewers commit nothing; the start commit tells the two apart without asking git.
- **Ask git whether the tip is in the base:** exact for a base that moved on, but a git call per branch in the pure plan's facts, for what the start commit already answers.
