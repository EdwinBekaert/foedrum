# 0164. A batch merges its base before its last check

Date: 2026-10-23 · Status: Accepted · Amends [0071](0071-the-openpullrequest-action-two-effects-of-the-batch.md) (the pull request holds the base as green checked it), [0066](0066-the-task-tree-continues-from-the-latest-succeeded-attempt.md) (a check that merges the base moves the task tree to its merge commit) and [0069](0069-check-steps-run-the-repositorys-commands-in-an-attempt-of-their-own.md) (the driver merges the base before the last check runs)

## Context
A batch's steps commit to its task tree, which starts at `origin/<base>` when the batch's first attempt makes its worktree ([ADR 0066](0066-the-task-tree-continues-from-the-latest-succeeded-attempt.md)).
Nip's `green` step checks the task tree, and `openPullRequest` pushes it and opens the pull request ([ADR 0071](0071-the-openpullrequest-action-two-effects-of-the-batch.md)).
Nothing brought in what merged into the base while the batch brewed, so the pull request could open behind the base, or conflicting with it.
#431, the second order Foedrum brewed on itself (#374), opened behind main with a conflict in `test/unit/serve-config.test.ts`: #416 and #418 had merged during the brew of about 15 minutes, and a person merged main by hand.
#412 decided (2026-10-23, decision 4) that the base is merged before green, so green checks the code the pull request will hold (#436).

Foedrum needs git 2.31 (ADR 0109), and `git merge-tree --write-tree`, which merges without a worktree, came in 2.38: the merge needs a worktree, and an action step has none (ADR 0071).

## Decision
- **The recipe's last check step that expects to pass, when an openPullRequest step follows it, merges the base before it runs** (`Recipe.mergesBase`): Nip's `green`. The openPullRequest step is always the last (ADR 0071), so every check comes before it. Of a recipe's checks, only those its settings run count: a `when` reads only the recipe's settings (ADR 0064), so a last check they skip leaves the merge to the check before it. A red proof never merges, and neither does a check in a recipe without a pull request.
- **The driver merges it into that check attempt's worktree**, after the worktree is made and `step.started` is recorded and before the check runner starts, as an effect of the attempt through the ledger: `["<batch>","<step>",<attempt>,"merge_base"]`, under an effect's deadline (`baseMergeTarget`, `src/engine/base-merge.ts`; the git in `src/workspace/base-merge-git.ts`).
  - **The base as the remote has it now**: `BranchPush.baseTip`, the push's own fetch in a git directory of Foedrum's own ([ADR 0090](0090-the-push-fetches-the-base-in-a-git-directory-of-its-own.md)), so no second fetch path, and none of the clone's configuration takes part in the fetch.
  - **Nothing new**: when the attempt's start already holds the fetched commit (`merge-base --is-ancestor`), nothing is merged, and the ledger records `{ base }`.
  - **A clean merge**: `git merge --no-ff --no-edit --no-verify -m "Merge <base> before <step>" <commit>`, a commit of its own also when the start is behind the base, with no hook or fsmonitor of the clone's ([ADR 0137](0137-the-push-its-lookup-and-the-worktree-fetch-run-in-the-clone-again.md)). Every git call of the merge reads the worktree through its record under the clone (`--git-dir=<record>`, `--work-tree=<path>`), never by discovery from its folder, whose `.git` file a brewer can rewrite ([ADR 0029](0029-attempt-worktrees-layout-claims-and-repair.md), [ADR 0095](0095-the-cleanups-read-a-worktree-through-its-record-and-run-no-fsmonitor-or-hook.md)); the ledger records `{ base, merged }` (`MergeResult`, `src/schemas/store.ts`). The check then reads the merged tree, its attempt's branch becomes the task tree when it succeeds (ADR 0066), and the push carries the merge commit.
  - **A conflict**: the files git lists as unmerged, at most 50, then `git merge --abort`; the ledger records `{ base, conflicts }`, and the attempt ends `blocked` on a `divergence` with `conflicts with <base> in <files>`, so the batch goes Stuck with the options of any blocked batch. Another round would hit the same conflict; resolving one is the Blender's, later.
  - **Found by its key** (ADR 0033): a HEAD that moved from the attempt's start to a merge of it and a second commit is the merge a run killed before its record made, found as `{ base, merged }`; a HEAD still at the start has nothing to find, and a merge such a run left in progress (`MERGE_HEAD`) is aborted first. A kill on either side of the merge never merges twice. A kill also loses the attempt's lease, so its retry is a new attempt with a worktree and a merge of its own.
  - **A failure** (the fetch, git) records nothing and fails the attempt retryably: `the base could not be merged: <why>`.
- **Each attempt merges again**: a retry of green, or the next round after `onFail` sent the batch back to `implement`, starts at the task tree and merges the base as it is then.
- **Main moving between green and the push is left to CI**: the pull request opens on what green checked.
- The merge commit's author is git's, from the user's configuration, as a brewer's commits are.
- `foedrum serve`, `brew` and `resume` give the driver the merge through `ServeShell.merge` (`openWorktreeMerge`) and each repository's `BranchPush`.

## Consequences
- A Nip pull request opens up to date with its base as of green, or the batch is Stuck naming the files that conflict, instead of a pull request a person must merge main into.
- Green's readings are of the merged tree: a test that breaks only with what merged meanwhile fails green and goes back to Cellarman once.
- Every green attempt fetches the base once more; on an up-to-date base that is a round trip with no objects (ADR 0090).
- The merge runs in the worktree, so it reads the clone's configuration, as the engine's other calls in the clone do: a merge driver (`merge.<name>.driver`) named by a `.gitattributes` would run. Brewers cannot write the clone's configuration today (their file tools are scoped to the worktree, their shell to `git status`, `add` and `commit`), so this is the open part of #200 that ADR 0137 names, not a new path.
- `RepositoryWorktrees` has an optional `merge`; without it (the tests' drivers, the chaos harness) nothing is merged. `test/integration/base-merge.test.ts` shows the three cases with real git, and a merge found after a kill.

## Alternatives considered
- **A batch effect after `implement`, writing the merge commit to a ref, with a new kind of task tree.** More state, and `decide` would have to hold green until the effect is recorded, racing the drive that starts it.
- **An implicit `merge-base` action step before green.** An action step has no worktree, and a step the loader adds changes the recipe's step ids and the status comment.
- **`git merge-tree --write-tree` in the clone.** No worktree, but it needs git 2.38.
- **Merge in the check runner.** Outside the ledger: a kill after the merge and before the check would leave nothing to find it by, and the runner has no effect deadline.
- **Merge after green, before the push.** The pull request would hold code no check read.
