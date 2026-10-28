# 0244. A conflict with the moved base sends its batch back to the fix step

Date: 2026-10-28 · Status: Accepted · Amends [0226](0226-a-failing-check-on-the-merged-tree-sends-its-batch-back-to-the-fix-step.md) (a third cause of the route back, and a routed start merge that leaves its conflicts in), [0164](0164-a-batch-merges-its-base-before-its-last-check.md) (a merge whose conflicts the brewer concludes counts as the base merged), [0198](0198-an-open-pull-request-is-merge-tree-checked-when-its-base-moves.md) and [0209](0209-a-check-that-fails-on-an-open-pull-request-s-merged-tree-is-posted-on-it.md) (a conflict's post says Foedrum fixes it), [0117](0117-a-retry-resumes-the-session-of-the-attempt-before-it-in-that-attempt-s-worktree.md) and [0118](0118-retrymode-resume-loads-and-an-answer-resumes-the-session-that-asked.md) (a resumed retry or answer of a routed fix runs the start merge in the worktree it continues, and its prompt names the files still unmerged)

## Context
Since [ADR 0226](0226-a-failing-check-on-the-merged-tree-sends-its-batch-back-to-the-fix-step.md) a check that fails on an open brewed pull request's merged tree sends its batch back to the recipe's fix step, for the rounds the head's failed checks share ([ADR 0219](0219-a-failing-check-on-an-open-pull-request-sends-its-batch-back-to-a-fix-step.md)).
A conflict with the moved base ([ADR 0198](0198-an-open-pull-request-is-merge-tree-checked-when-its-base-moves.md)) is only posted on the pull request, and the batch stays On tap until a person acts.
The maintainer decided on #274 (2026-10-26) that a pull request that is not ready means the work goes on; #574 is the conflict's half of #547.

Three facts shaped it.
A conflict exists only in a merge: the brewer can resolve it only in a worktree where the merge is in progress, with git's markers in the files it could mark.
Some conflicts have no markers: a binary file, a file one side deleted and the other changed, a file both added; git names each by its status (`git status --porcelain=v2`, `UU`, `UD`, `AA` and so on).
And today every start merge aborts a conflict and ends the attempt blocked on a divergence (`mergeEnding`, ADR 0164), and a run killed during a merge has it aborted when the merge is found again (`baseMergeTarget`).

## Decision

### The cause
- **`FixCause` gains `{ kind: 'conflict', tip }`.** `pullRequestProblem` gives it when the latest base check of the latest push's head conflicts, in the place a merged-tree failure has: a check either conflicts or ran the merged tree, never both; before the head's own failed checks, one cause per round as in ADR 0226.
- A check without `head` is never a cause, as in ADR 0226.
- **The supervisor issues it** (`fixCommand`, `causeOf`); `decide` reads the problem again and refuses any other pull request, head, cause or tip.
- **`ScheduleRoute`'s `cause` gains `'conflict'`**, with its `tip`, the tip the check merged.

### The start merge leaves the conflict in
- **Every routed start merge keeps a conflict** (`routedMerge`): an attempt that a `pull_request` route scheduled with a cause, a merged-tree failure's or a conflict's, and a retry or an answer of it that starts fresh, merges the base's tip as the push fetches it ([ADR 0090](0090-the-push-fetches-the-base-in-a-git-directory-of-its-own.md)) and, on a conflict, keeps the merge in progress with its markers instead of aborting it. The attempt runs.
- **The ledger records it under the same key** as ADR 0164's merge, `["<batch>","<step>",<attempt>,"merge_base"]`: `MergeResult` gains a third shape, `kept`, the files left unmerged (at most `MAX_CONFLICTS`, each with its status and whether it holds no conflict marker) and how many more.
- **The merge before the last check, ADR 0164's own, still aborts and blocks**: no brewer runs at that step to resolve it.
- **A kept merge is never aborted.** The routed target's `find` keeps a merge in progress and records it as kept, with the files still unmerged. A HEAD that moved past the start in another way, which only a resumed worktree has, is not an error there: the merge is applied again from HEAD, and finds nothing new when HEAD holds the tip.
- **A resumed retry runs the routed merge too, in the worktree it continues.** One whose worktree still holds the merge, partly resolved, continues it. One whose worktree was recreated without it merges again, with the conflicts left in. Either way the resumed session is told which files are still unmerged (below).

### The brewer concludes it
- **It resolves each file, `git add`s it and `git commit`s**, which `git.commit` grants already ([ADR 0074](0074-git-commit-grants-fixed-git-rules-and-done-needs-a-commit.md)). The merge commit, with the start and the tip as parents, is the round's.
- **A `done` with the merge unconcluded fails the attempt retryably**: the driver reads the worktree after the run. A merge still in progress names the files still unmerged. A HEAD that does not hold the tip, the merge aborted, says so.
- **The commit count, `testsUnchanged` and the secret scan read the brewer's merge commit as they read ADR 0226's start merge commit**: from the worktree's start on, the merge commit included. The count sees at least the merge. The scan reads it as the push would. `testsUnchanged` compares the step's commits from its first attempt's start ([ADR 0078](0078-the-red-proof-reads-the-test-report-and-testsunchanged-compares-lines.md)), as for the merge Foedrum makes.
- **`mergedBase` counts a kept merge as the base merged at its tip once its attempt succeeded**, which it does only once the merge was concluded; a kept merge of an attempt that failed counts for nothing, since its worktree's commits are not the task tree's. Green's merge then finds nothing new.

### The route input
- `Pull request <url> no longer merges cleanly with <branch> at <tip>.`, then the files the start merge left in conflict, each with its status (`both modified`, `deleted by them`, `added by us` and so on), a file without a conflict marker named so (binary or unmarked), at most `MAX_CONFLICTS` and a count of the rest, every name on one line.
- Then that the merge is in progress in this worktree with its markers, to resolve, `git add` and `git commit`, never to abort, and that the recipe's checks run after the step.
- It reads the start merge's ledger record, whose tip may be newer than the check's. A merge that found nothing to merge, or merged cleanly, says so. No record says the base is not merged.
- A merged-tree route whose start merge kept a conflict gets the same lines after its own.
- A retry or an answer that starts fresh of an attempt whose start merged the base, for either cause, gets the route input of the attempt it retries, since its worktree holds the merge too (`routeOf` reads the route behind it, as `routedMerge` does). A resumed session gets only the files still unmerged and what to do with them: it holds its first prompt ([ADR 0117](0117-a-retry-resumes-the-session-of-the-attempt-before-it-in-that-attempt-s-worktree.md)).
- Its source: `why step <goto> runs again: the conflict of pull request <url> with <branch>`, untrusted, in the nonce tags, held to 64 KiB ([ADR 0128](0128-an-attempt-a-route-schedules-gets-what-sent-it-back.md)).

### Rounds and Stuck
- **The same shared `maxRounds`.** When they are used, the batch is Stuck `pull_request_failed` with `cause: { kind: 'conflict', branch, tip, files }`, the files as the check recorded them.
- The status comment says `<pr> conflicts with <branch> at <tip> after <n> rounds: <files>`, and `foedrum status` `<pr> conflicts with <branch> at <tip> in <files>, at <step> after <n> rounds`, as each says a merged-tree failure.
- `retry` sends it back with the same cause; `skip`, `rewind`, `recipe` and `cancel` act as for the other causes.

### The post stays and says so
- **A conflict's post, when the recipe has the route, says Foedrum sends the batch back to resolve it**, at most `<maxRounds>` rounds, unless a person holds or skips it, as a merged-tree failure's post does. It is due while the batch brews or is Stuck after the route, as ADR 0226 made it.

## Consequences
- A brewed pull request that conflicts with a base that moved gets up to `maxRounds` merge commits pushed to its branch, each concluded by a brewer in a worktree with the merge in progress, then a Stuck batch that names the files.
- A merged-tree route whose start merge meets a new conflict no longer ends blocked: its brewer resolves both.
- Three schemas move: `ScheduleRoute`, `StuckReason` and the ledger's `MergeResult`. An older Foedrum cannot read a log that holds a conflict route, its Stuck or a kept merge.
- A brewer that leaves the merge unconcluded spends an attempt, not a round.

## Alternatives considered
- **A Blender step the loader adds.** ADR 0164 rejected a step the loader adds: it changes the recipe's step ids and the status comment, and the recipe's own fix step and its brewer already hold the change and its tests.
- **Resolve with a strategy (`-X ours`, `-X theirs`).** It drops one side's change without a reader, and gives no binary file a right answer.
- **Abort and hand the brewer a list of files.** It cannot see the markers, and would have to redo the merge with a git command its rules do not grant.
- **Keep only the conflict route's merge, and still block a merged-tree route's.** Two rules for one start merge; the brewer that fixes the merged tree is in the right place to resolve a conflict too.
- **Abort a half-done merge on a resumed retry.** It throws away a brewer's resolution, which is the work the round is for.
- **Fail a `done` with the merge unconcluded without a retry.** A brewer that forgot the commit fixes it in one more attempt, and the retry sees the same worktree.
