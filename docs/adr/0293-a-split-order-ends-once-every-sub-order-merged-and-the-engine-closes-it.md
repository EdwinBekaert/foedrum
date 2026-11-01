# 0293. A split order ends once every sub-order merged, and the engine closes it

Date: 2026-11-01 · Status: Accepted · Amends [0285](0285-an-approved-plan-becomes-brewery-sub-issues-through-the-ledger.md) (the order's issue closes once its sub-orders merged), [0292](0292-the-pull-requests-of-one-order-name-each-other-and-the-merge-order.md) (the order's status comment rolls up each sub-order's lane and release and says when the order is done) and [0296](0296-a-target-repository-s-pull-request-names-no-brewery-issue-and-the-engine-closes-it.md) (a split order's own batch is closed on the same source)

## Context
After `foedrum approve` ([ADR 0281](0281-foedrum-approve-signs-off-a-plan-by-its-hash-and-puts-the-batch-on-tap.md)) a split order's own batch is on tap with no pull request, and its sub-orders brew and merge on their own ([ADR 0285](0285-an-approved-plan-becomes-brewery-sub-issues-through-the-ledger.md)).
Each sub-order's Brewery issue closes once its batch's pull request merged ([ADR 0296](0296-a-target-repository-s-pull-request-names-no-brewery-issue-and-the-engine-closes-it.md)), but the order's issue stayed open with nothing left to do, and its status comment never said the order was done.
The status comment listed each sub-order's pull request ([ADR 0292](0292-the-pull-requests-of-one-order-name-each-other-and-the-merge-order.md)), but a sub-order with none said only `no pull request yet`, and nothing said a repository was released after its merge.
The maintainer decided on 2026-10-31 (#738) that the order's issue is closed with a comment once every sub-order's pull request merged: a Brewery is one person's working space ([ADR 0263](0263-the-state-branch-is-separate-so-the-engine-is-its-only-writer.md)), and an open issue there is work left.

## Decision
- **The sub-orders that count are the ones the order's latest breakdown keeps** (`subOrderPullRequests`): one a later breakdown left out is cancelled, never deleted ([ADR 0014](0014-interactive-refinement-plugin.md)), and is no longer the order's work.
- **The order is done once every one of them has a merged pull request** (`orderEnd`, `src/engine/order-end.ts`).
  Done needs no release of the last one: a release a sub-order waited for is behind its blocker's merge already, since its batch starts only after it ([ADR 0216](0216-a-release-blocker-is-done-once-its-repository-is-released-after-its-merge.md)).
- **What keeps it open, named**: a sub-order whose latest batch a person cancelled (`cancelled`), whose latest batch's pull request closed without merging (`closed without merging`), or that has no batch and whose approved plan entry was not ready (`needs refinement`, the entry read from the approved attempt's out doc as `plan-entry` reads it, [ADR 0290](0290-a-sub-order-s-brewers-read-its-plan-entry-from-the-parent-s-recorded-plan.md)).
  Each waits for a person; a sub-order that is only waiting, for its blockers or its brewers, is not named.
- **The order's status comment** (`renderStatus`) says, under its On tap line, `🍻 **Done**: every sub-order merged` once it is done, else `Keeps the order open: #<n> (<why>), …` while one is left, then a line per sub-order in merge order:
  - with a pull request, `- #<n> in <repo>: <pull request>, <state>`, and after a merge `, released as <tag>` with the release's page when it has one, once a release of its repository is recorded after the merge (`releaseAfterMerge`, the judgement the ready set makes);
  - with none, its latest batch's lane in a word and `no pull request yet`, else `needs refinement`, else `not ordered yet`.
- **The engine closes the order's issue** as [ADR 0296](0296-a-target-repository-s-pull-request-names-no-brewery-issue-and-the-engine-closes-it.md) closes a Brewery issue, on the same source (`breweryCloseEffects`) and keys of the order's own batch, once that batch is on tap, the latest of its issue, and the order is done:
  - `["<batch>","close.comment"]` comments `Every sub-order merged: <owner/name>#<n>, …. Foedrum closes this order.`, found by its marker;
  - `["<batch>","close.issue"]` closes it, found when it is closed already.
  A deleted issue ends both as `gone`, and one closed already gets no comment.
- **The close does not wait for the status comment's Done revision**: status revisions are limited to one a minute ([ADR 0072](0072-the-status-comment-edits-as-revisions-in-the-ledger.md)) and still edit a closed issue, so the Done line lands within its minute either way, and a wait would make one effect source read another's ledger.

## Consequences
- A split order now ends on its own: its issue closes, and its status comment says it is done with every pull request and release.
- An order whose sub-orders all merged before this change is closed, with the comment, on a driver's first pass after the upgrade: that is the gap this record closes. One a person closed already gets no comment.
- A person who reopens the order's issue is left alone: both effects are in the ledger, so nothing closes it again; ordering it again starts a new batch, which is not split.
- A sub-order cancelled by a person, or with a pull request closed unmerged, keeps the order open until a person orders it again or plans the order again without it; the status comment says which.
- The pull request bodies' sibling section ([ADR 0292](0292-the-pull-requests-of-one-order-name-each-other-and-the-merge-order.md)) is unchanged: it names pull requests only, never a Brewery issue or a lane.

## Alternatives considered
- **Close without a comment**: the issue would not say what did its work.
- **Count every sub-order the order ever had**: one a later breakdown cancelled would keep the order open forever, though no plan asks for it any more.
- **Wait for the release of the last sub-order's repository**: nothing waits for it; a release blocker's release is already behind the merge of what waited on it.
- **A second close source for orders**: two sources would hold two copies of the same find-then-apply close; the order's is one case of ADR 0296's.
