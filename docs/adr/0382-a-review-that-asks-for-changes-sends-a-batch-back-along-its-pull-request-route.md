# 0382. A review that asks for changes sends a batch back along its pull request route

Date: 2026-11-11 · Status: Accepted · Amends [0219](0219-a-failing-check-on-an-open-pull-request-sends-its-batch-back-to-a-fix-step.md) (a fourth cause of the `onPullRequestFail` route and of the `pull_request_failed` Stuck reason), [0128](0128-an-attempt-a-route-schedules-gets-what-sent-it-back.md) (one more kind of route input), [0225](0225-a-ready-pull-request-gets-a-merge-brief.md) (the brief's What changed names a review round) and [0052](0052-github-reads-rate-limit-pauses-and-the-polling-interval.md) (one more conditional read per open pull request per pass)

## Context
Once a batch's pull request was open, the only automatic way back to its brewers was a failing check, a failing merged-tree check or a conflict with a moved base ([ADR 0219](0219-a-failing-check-on-an-open-pull-request-sends-its-batch-back-to-a-fix-step.md), [ADR 0226](0226-a-failing-check-on-the-merged-tree-sends-its-batch-back-to-the-fix-step.md), [ADR 0244](0244-a-conflict-with-the-moved-base-sends-its-batch-back-to-the-fix-step.md)).
A person's review had no route.
In the self-brew trial (#374) a review found about 20 points on #868, and a session fixed them by hand; that push was someone else's, so the engine's base check and merge brief stopped for that pull request ([ADR 0198](0198-an-open-pull-request-is-merge-tree-checked-when-its-base-moves.md), [ADR 0350](0350-a-brewed-pull-request-is-a-draft-until-its-merge-brief-and-the-next-line-follows-the-brief.md)).
This is #872.

The maintainer decided (2026-11-11): a GitHub review with "Request changes" by someone in the Brewery's `users` sends the batch back to its Cellarman; the review's comments are what it fixes, on the same branch, through the recipe's checks and Tasters, with rounds bounded as today; a review by anyone else changes nothing; there is no new command; the review's text is untrusted input, as every comment that reaches a brewer is ([ADR 0041](0041-untrusted-input-in-per-prompt-nonce-tags.md)).

Four facts shaped it.
- **GitHub's own rule says where a reviewer stands.** Each reviewer's latest review that approves, requests changes or was dismissed counts; a comment does not change it. A request for changes stays on the pull request until its author reviews again or someone dismisses it, so the same review is listed on every later read.
- **The reviews list is conditional.** `GET /repos/{owner}/{repo}/pulls/{n}/reviews` lists every review in chronological order, `user` null for a deleted account, `commit_id` possibly null; `GET …/reviews/{id}/comments` lists a review's comments, each with `path`, `line` (null on an outdated comment or one on the whole file) and `body`. Both read through the ETag cache answer 304 when nothing changed (GitHub's REST documentation, read 2026-11-11).
- **ADR 0219 named the route by the pull request, not its cause**, and two more causes already share it.
- **The intake already reads the open pull request that `openOf` gives** each pass, its head and its checks ([ADR 0213](0213-an-open-pull-request-s-checks-on-its-head-are-recorded-once-they-finish.md)); the supervisor turns what the fold holds into `fix_pull_request`.

## Decision

### The pass reads the reviews
- **Each intake pass, after the checks** (`recordReviews`, `src/engine/pr-reviews.ts`), reads the reviews of the pull request `openOf` gives for each batch on tap: one conditional request per started page of 10 (`githubReviewReader`, `src/github/reviews.ts`), 10 to a page since a review's body may hold 65,536 characters, as ADR 0052 pages comments.
- **Which reviews ask for changes** (`askingReviews`): of each login in `users` but the Brewery's own, compared ignoring case as ADR 0359 compares them, the latest review by id whose state is `APPROVED`, `CHANGES_REQUESTED` or `DISMISSED`, when it is `CHANGES_REQUESTED`. A later approval takes a request back; a dismissed one asks nothing; a comment changes nothing; a deleted account's review counts for no one.
- **A review by anyone else is never recorded**, so its text never reaches the event log, the state branch or a brewer, and the status comment says nothing of it: the review is on the pull request for anyone to see.
- **Recorded when they change** as `pull_request.reviews_read`: the reviews that ask for changes and have not sent the batch back, oldest first, at most 5 and how many more, each with its id, its author, the commit it reviewed, its body, and its comments at their file, on one line with its line breaks as spaces, and line, at most 30 and how many more. The comments of a review are read once, when it is first recorded; a later record keeps its text. A record with none follows once they no longer ask. The admission refuses a record of the same reviews.
- **What is kept is read for secrets** before it is recorded: a line that looks like one is left out for a fixed line, as a job's log is ([ADR 0088](0088-out-doc-text-that-looks-like-a-secret-is-left-out-of-the-pull-request-and-the-status-comment.md), [ADR 0228](0228-a-failed-actions-job-s-log-goes-with-the-batch-back-to-its-fix-step.md)); control characters but the tab and line feed go; a body or comment keeps its first 4,000 characters, a path its first 1,000.

### The batch goes back along the same route
- **The fourth cause, `review`, comes last** in `pullRequestProblem` (`src/engine/pull-request-fix.ts`): after a conflict, a failing merged-tree check and failing checks on the head, the recorded reviews that ask for changes and whose ids no route of that pull request named yet. The supervisor issues `fix_pull_request` with `cause: { kind: 'review', reviews: [<ids>] }` and decide checks it again on the state it decides on, as ADR 0219 does.
- **Every review that asks goes back in one round**: the route carries `cause: 'review'` and `reviews`, the ids it answers. A review a route named is acted on: it never sends the batch back again, though GitHub lists it until its author reviews again. A new request for changes is a new review and goes back in a round of its own.
- **The rounds are shared** with the other causes: `maxRounds` counts them together over the batch's life ([ADR 0369](0369-a-recipe-s-routes-count-their-rounds-per-run-an-open-pull-request-s-over-the-batch-s-life.md)). A recipe without `onPullRequestFail` sends nothing back for a review, as for a failing check.
- **Past its rounds the batch is Stuck** `pull_request_failed` with `cause: { kind: 'review', reviews: [{ id, by }], more }`, at most 5; the status comment says `` `<step>`: <url> got changes asked for on `<sha>` after <n> rounds: review <id> by <login>, … ``. `retry` sends it back once more with the same reviews; `skip` leaves that head as it is, so no later review of it sends the batch back, as a skip settles a failing head (ADR 0219).

### What the Cellarman reads
- **The route input** (`reviewRouteOf`, `src/brewers/attempt-plan.ts`) lists each review the route names: its id, author and commit, its body, and each comment as `- <login> on <path> line <n>:`, each line of a person's text indented under its own line, how many comments the record left out, then a fixed line that these are a person's words, to change the code for each or say in the out doc why not, and that the recipe's checks and Tasters run after the step.
- **Its source is** `why step <goto> runs again: the changes asked for in the reviews of pull request <url>`, inside the nonce tags and the 64 KiB bound of every route input ([ADR 0041](0041-untrusted-input-in-per-prompt-nonce-tags.md), [ADR 0128](0128-an-attempt-a-route-schedules-gets-what-sent-it-back.md)).
- **Text, not findings**: the review's comments are not Taster findings with a severity and a lens, so they reach no dispositions and no merge brief's findings list; the out doc says what was done.

### The pull request
- **It goes back to a draft** when the round sends the batch back, as for any route: its merge brief is no longer current once the batch leaves on tap ([ADR 0350](0350-a-brewed-pull-request-is-a-draft-until-its-merge-brief-and-the-next-line-follows-the-brief.md)). The round's push is a new head, which gets a new brief once its checks pass.
- **The round merges no base at its start**: only a merged-tree or conflict route does (`mergeRouteOf`, [ADR 0226](0226-a-failing-check-on-the-merged-tree-sends-its-batch-back-to-the-fix-step.md), [ADR 0244](0244-a-conflict-with-the-moved-base-sends-its-batch-back-to-the-fix-step.md)); the last check merges the base as on every round ([ADR 0164](0164-a-batch-merges-its-base-before-its-last-check.md)).
- **The merge brief's What changed** names the round by its reviews: `- Round <n>: review <ids> asked for changes on <sha>, and it pushed <sha>.` (`changedLines`, `src/engine/merge-brief-post.ts`).
- **The round pushes to the same branch**, so the base check, the checks and the brief go on; nothing changes for a person who pushes to the branch themselves: Foedrum follows that pull request no more.

### What it costs
- Counted from the code: per pass, one conditional request per started 10 reviews of each pull request `openOf` gives, a 304 that does not count against the primary limit while nothing changed (ADR 0052), and one more path in the 256-answer cache per open pull request; one more per started 10 comments of a review that asks for changes, once, when it is first recorded.

## Migration
None: Foedrum has no release, and no Brewery file changes. A recipe with `onPullRequestFail` gets the review cause with it.

## Consequences
- A person in `users` reviews a brewed pull request on GitHub as any other, asks for changes, and the batch's Cellarman makes them on the same branch, through the recipe's checks and Tasters, while the base check and the merge brief keep working.
- **A flaky check can use the round a review would have had**, since the rounds are shared; `retry` goes on past them.
- An edited review keeps its id, so it is not acted on again; the batch got its text as it was recorded. To ask for more, a person submits a new review.
- A review's comment that is not on the latest head (outdated) is passed on without a line.
- A skip of a review's Stuck settles that head for every later review too, until a new head.
- Two schemas move: `ScheduleRoute` gains `cause: 'review'` with `reviews`, and the `pull_request_failed` reason a `review` cause; the event log gains `pull_request.reviews_read`. An older Foedrum cannot read a log that holds them.

## Alternatives considered
- **A route of its own, `onReview`**: rounds apart from failing checks, but a second route kind in the recipe schema, its loader, its rounds and both default recipes, for a case `retry` covers.
- **A command, `foedrum fix <n>`, or a marked comment**: a second way to say what GitHub's review already says (the maintainer, 2026-11-11).
- **Every review's text in the record, trusted or not**: a stranger's text would reach the state branch for nothing, since it sends nothing.
- **Only a review of the latest head counts**: a review written while a check-fix round ran would never count.
- **GraphQL's `reviewDecision`**: one request, but never a 304, so it would count against the rate limit on every pass.
- **The comments as Taster findings**, with dispositions and the brief's findings list: they have no severity or lens, and the findings shape is changing in #927.
- **A status line for a stranger's review**: one more state kept for nothing a person must do.
