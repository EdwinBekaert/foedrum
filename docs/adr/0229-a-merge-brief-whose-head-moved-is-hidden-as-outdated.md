# 0229. A merge brief whose head moved is hidden as outdated

Date: 2026-10-27 · Status: Accepted · Amends [0225](0225-a-ready-pull-request-gets-a-merge-brief.md) (an outdated brief is hidden, and the status comment says when none is ready)

## Context
A merge brief names one head and one record of its checks ([ADR 0225](0225-a-ready-pull-request-gets-a-merge-brief.md)).
When the head of the pull request moves, by a fix round's push ([ADR 0219](0219-a-failing-check-on-an-open-pull-request-sends-its-batch-back-to-a-fix-step.md)) or by a person's push to the bottle branch ([ADR 0198](0198-an-open-pull-request-is-merge-tree-checked-when-its-base-moves.md), `branchMoved`), the old brief still sits on the pull request and says "Ready to merge" of a head that is no longer the one that would merge.
ADR 0225 left it as posted: "Hiding an outdated brief is #549's".
The maintainer settled on #274 (2026-10-25: "A new head hides the old brief as outdated and waits for CI again"; 2026-10-26: "A brief for an older head is hidden as outdated").
And the status comment says nothing when no brief is current, so a person reading it cannot tell "not ready yet" from "not built to say".

Three facts shaped it.
GitHub hides a comment with the GraphQL mutation `minimizeComment(input: { subjectId, classifier: OUTDATED })`, by the comment's node id, which the REST comment answers as `node_id`; whether a comment is hidden is its `isMinimized` ([GitHub's GraphQL reference: `minimizeComment`](https://docs.github.com/en/graphql/reference/mutations#minimizecomment), [`Minimizable`](https://docs.github.com/en/graphql/reference/interfaces#minimizable)).
Minimizing needs write access to the repository, which a Brewery has to the repositories it pushes to.
And an effect is found on the code host before it is applied, so a kill between the two applies it once ([ADR 0033](0033-chaos-tests-effects-found-by-key-and-leases-at-start.md)).

## Decision

### When a brief is outdated
- **Brief `n` is outdated** (`outdatedBriefs`, `src/engine/merge-brief.ts`) when it is recorded, not yet hidden, its pull request has no recorded end (`Batch.pullRequestEnds`), and either:
  - the head of its pull request is no longer the brief's: the batch's latest push recorded another commit, found the branch at someone else's (`moved`) or gone, or a base check of that pull request recorded `branchMoved` (a person's push); a push that pushed nothing (`empty`, `refused`) left the head where it was; or
  - a later brief `m > n` is recorded: a re-run or a late check on the same head posted a newer record's brief, so only the latest brief stays open. Decided by the maintainer (2026-10-27).
- **A brief whose pull request merged or closed is left as it is**: it is history, and on a merge it described the head that merged. Decided by the maintainer (2026-10-27).
- **A record that goes pending or fails on the same head hides nothing**: the brief still names that head, and a pending record that finishes the same posts nothing again (ADR 0225), so hiding it then would leave no brief at all.
- **A hidden brief is never current**: `briefNow` gives no brief whose hide is recorded, and the post's `due` posts the next number for a ready record whose latest brief was hidden.

### One effect per hidden brief
- **`[batch, "brief.<n>.hidden"]`**, beside the post in `mergeBriefEffects` (`src/engine/merge-brief-post.ts`), so one `DriverEffects` keeps both and the wiring changes only the host. The key never matches `latestBrief`'s `brief.<n>` loop.
- **Found** when the comment the ledger's `MergeBrief.comment` names is already hidden (`isMinimized`), or gone (404, or no longer the Brewery's own).
- **Applied** by reading the comment through REST (the Brewery's own, its `node_id`), then `minimizeComment` with `OUTDATED`.
- **The GraphQL answers** are checked with schemas (`CommentMinimized`, `MinimizedComment`, `src/schemas/github.ts`), and `GitHubComment` gains `node_id`.
- **Its ledger result** (`MergeBriefHidden`, `src/schemas/status-comment.ts`, beside `MergeBrief`): `{ comment, hidden: 'outdated' }`, or `{ comment, gone: true }` for a comment that is not there to hide.
- **A failed read or mutation**, a GraphQL error included, fails the effect, which the next pass tries again, as the post does.
- **The hides due come before the post**, and each has its own key and its own `find`, so a kill between them neither hides twice nor posts twice.

### The post is unchanged
- A new brief for the new head is posted only when `readyOf` gives its record (ADR 0225).
- Between the old head's hide and the new head's ready record, the pull request has no open brief.

### The status comment
- **While the pull request is open** (`openOf`) **and no brief is current** (`briefNow` gives none), one line under its pull requests, also while its checks are pending: `- <url> is not ready to merge yet: no merge brief.` (decided by the consultant, 2026-10-27).
- **The current brief's line** is as ADR 0225 wrote it; a hidden brief is never linked.
- `renderStatus` keeps its parameters: `brief` is the current brief, or the open pull request that has none (`BriefLine`).

### Proof
- A fake host in the unit and chaos tests, and GitHub's GraphQL reference cited above; no integration test, since no test reaches GitHub and the mutation is one call through `client.graphql`, as `updateRefs` is (`src/github/claims.ts`). Decided by the maintainer (2026-10-27).

### Known gap
- An older record's brief that a kill left under the same key (ADR 0225, "it stays") is not in the ledger, so it is not hidden: the ledger names only the brief it recorded.

### What this is not
No change to when a brief is posted or what it says (ADR 0225), no body render (#548), no merged-tree route (#547), no conflicts with other open pull requests (#550).

## Consequences
- A pull request has at most one open brief from the ledger, of its current head while that head is ready; an older one collapses as outdated.
- One ledger entry per hidden brief; no new event, no change to the fold or the admission.
- Every On tap status comment is edited once after the upgrade, since its text gains the line of an open pull request with no brief.
- A person's push hides the brief, and since `openOf` gives nothing once someone else pushed (ADR 0198), no new brief is posted on that pull request, and the status comment shows no brief line for it.
- A comment a person deleted is recorded as gone and never asked about again.

## Alternatives considered
- **Edit the old brief's text to say it is outdated**: GitHub's own outdated state collapses it where every reviewer already knows the sign, and an edit would need a second text and a revision of its own.
- **Delete the old brief**: the evidence for a head that was once ready is history a person may want, and a delete cannot be undone.
- **Hide on a pending or failing record of the same head**: a pending record that finishes the same posts nothing again, so the pull request would be left with no brief at all.
- **Hide the brief of a merged or closed pull request too**: on a merge it described the head that merged; on a close nothing follows it.
- **Keep an earlier brief of the same head open beside a later one**: two "Ready to merge" comments for one head, one of them of checks that no longer stand (the maintainer, 2026-10-27).
- **Read GitHub for the pull request's head at hide time**: the ledger's push and the base check are the facts the engine, the post and the status comment agree on (ADR 0225's reason for its record).
- **One effect that hides the old brief and posts the new**: a kill between them would leave the next driver to find either half; two keys are each found on their own.
- **A new parameter of `renderStatus` for the open pull request**: parallel pull requests (#548, #547) add parameters after `brief`; widening `brief` keeps their lines apart.
