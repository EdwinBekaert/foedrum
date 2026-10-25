# 0198. An open pull request is merge-tree checked when its base moves

Date: 2026-10-25 · Status: Accepted · Amends [0068](0068-the-intake-in-foedrum-serve-brewery-orders-and-routing-by-label.md) (the intake records the end of every batch's pull requests, a Brewery issue's too) and [0072](0072-the-status-comment-edits-as-revisions-in-the-ledger.md) (the status comment shows how an open pull request merges with its base)

## Context
Since [ADR 0164](0164-a-batch-merges-its-base-before-its-last-check.md) a batch merges its base before its last check, so its pull request opens up to date.
From then on the batch is On tap, and the intake only waits for `pull_request.ended`.
When something else merges into the same base first, nobody looks at the open pull request again: a textual conflict shows on GitHub as "conflicting", and GitHub then runs no checks on it at all.
#271 was settled with the maintainer on 2026-10-25: Foedrum detects it and says so, and the batch stays On tap; the repair (a Blender step, a fix round) and the checks on the merged tree (#511) are issues of their own.

Two more facts shaped it.
The intake recorded `pull_request.ended` only for a claimed batch, the fact its release waits for, so a Brewery issue's pull request never ended in the log, and a check of every open pull request would go on checking it after its merge.
And `git merge-tree --write-tree`, which merges without a worktree, needs git 2.38, while Foedrum needs 2.31 ([ADR 0109](0109-a-brewer-s-git-holds-no-push-credential.md)).

## Decision
- **Each intake pass checks the Brewery's own open pull requests**, after it records their ends (`checkBases`, `src/engine/base-check.ts`): for each batch On tap, the pull request its ledger opened (ADR 0071) with no recorded end, and the commit its push recorded.
  - **The base's tip as the push's own fetch reads it** (`BranchPush.baseTip`, [ADR 0090](0090-the-push-fetches-the-base-in-a-git-directory-of-its-own.md)), once per repository and pass: a merge into the base by anyone counts, not only Foedrum's.
  - **Only when it moved**: since the pull request's last check, else since the base the batch's last merge read (ADR 0164); a batch with neither is checked once.
  - **`git merge-tree --write-tree --name-only --no-messages -z <head> <tip>`** in a git directory of Foedrum's own, with the clone's objects (`withOwnGitDir`, `src/workspace/merge-tree-git.ts`): no hook and no configuration of the clone's takes part, so no merge driver a `.gitattributes` names runs; in a blobless clone a blob it lacks comes from the URL Foedrum names, as the base fetch's do (ADR 0137). It writes only the merged tree's objects, which no ref holds. Exit 0 is clean; exit 1 lists the conflicting files, at most 50 (`MAX_CONFLICTS`); anything else is a failure.
  - **Every check is recorded**: `pull_request.base_checked` with the pull request, the base branch, the tip, and the conflicting files when there are any. A failed fetch or merge-tree records nothing and is reported; the next pass tries again, and nothing is ever posted that no check saw. A pass given up at its deadline records nothing more.
- **A conflict is posted when it first appears or when its set of files changes**, as one comment on the pull request (`baseConflictEffects`, `src/engine/base-check.ts`), through the ledger as `[batch, "base_conflict.<n>"]` and found by its marker on the Brewery's own comment (ADR 0033). A new tip with the same files posts nothing; a clean check posts nothing. The comment says that the base moved, to which commit, the files, and that the batch stays On tap.
- **The status comment shows the latest check** of each pull request under it: the tip and the files of a conflict, or, when an earlier check conflicted and the latest is clean, that it merges cleanly again. A pull request whose checks were all clean shows nothing.
- **The batch stays On tap.** Nothing is sent back; repair is a later issue's.
- **The intake records the end of every batch's pull requests**, a Brewery issue's too, so a merged or closed pull request is checked no more. For a Brewery issue's batch the end changes nothing else: its release and claim effects read only a claimed batch's (ADR 0043).
- **Only with git 2.38 or later.** `foedrum serve` reads git's version once at its start; below 2.38 it says so in one line and no base check runs: no failure each pass, nothing posted. `foedrum doctor` says the same in one advice line. Foedrum's required git stays 2.31; raising it is a follow-up.

## Consequences
- An open pull request whose base moved into a conflict gets one comment and a line in its status comment within a pass, whoever merged into the base.
- Each pass fetches the base of every repository with an open pull request once; on an unmoved base that is a round trip with no objects (ADR 0090), and no merge-tree runs.
- `pull_request.base_checked` is a new event: an older Foedrum cannot read a log or state branch that holds one.
- The head checked is the commit Foedrum pushed: commits a person pushed to the bottle branch since are not read.
- A head the clone no longer has (its objects pruned) fails the merge-tree each pass, reported, and posts nothing.
- A Brewery issue's batch now gets `pull_request.ended` events, one more request per pass for each of its open pull requests until it ends.

## Alternatives considered
- **Post once per tip.** A busy base would comment on every merge into it with the same files.
- **Merge in a worktree, as ADR 0164 does.** A worktree per open pull request per base move, and the clone's configuration with it, for an answer merge-tree gives without one.
- **Raise the required git to 2.38 here.** It would refuse machines that brew today for a check that is new; doctor's advice says what it needs.
- **Run it on the driver's ticks.** A fetch per repository can take as long as a tick's work; the intake pass already runs beside the ticks with a deadline of its own (ADR 0068).
