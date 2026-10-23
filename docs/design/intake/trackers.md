# Trackers and code hosts

Foedrum separates three roles that GitHub happens to play all at once in 1.0:

| Role | Interface | 1.0 | Later candidates |
|---|---|---|---|
| Where orders come from and where status is shown | `Tracker`: list orders, read comments/commands, post and edit the status comment, set state markers (labels, statuses) | GitHub Issues | Jira, Linear, GitLab Issues |
| Where code lives and pull requests are opened | `CodeHost`: clone, push, open pull request, read review comments; for now its push is `BranchPush` (git in the clone) and its pull requests `PullRequestHost` ([ADR 0071](../../adr/0071-the-openpullrequest-action-two-effects-of-the-batch.md)) | GitHub | GitLab, Bitbucket, Azure DevOps |
| Where configuration lives | the Brewery: any git repository | GitHub | any git host |

The user chooses a tracker and a code host per Brewery (`foedrum.jsonc`), and they may differ (for example Jira orders, GitHub pull requests).

**Design rule: a tracker is intake and projection only.** The event store is the source of truth; Foedrum reads orders and commands from the tracker and writes status back to it, but never synchronises workflow state two ways.
Tracker-specific concepts (issue types, workflow transitions, re-parenting, key renames) are mapped at the edge, in the adapter, and never leak into the engine.
Two-way tracker synchronisation is the most expensive part of an orchestrator to build and keep correct; this rule keeps adapters small.
The claim on a target-repository issue ([target-repository issues](../intake/target-issues.md)) is no exception: its ref is the one fact Breweries share: the engine creates it, reads only its record to tell its own claim from another's, and deletes it, and never reads workflow state back from it.

## Sub-issues and dependencies on github.com (spike #18)

These are the notes the GitHub `Tracker` adapter is designed from, for the sub-orders and their "blocked by" links ([work breakdown](work-breakdown.md)).
They were taken on 2026-10-23 from GitHub's REST and GraphQL docs and then tried with `gh api` (keyring login) on the private Brewery `EdwinBekaert/foedrum-brewery`, issues #2–#6, labelled `spike:18` and closed afterwards.
It is a spike: no code and no ADR follow from it here.

### Identifiers and the version header

Every REST write names the other issue by its numeric REST `id` (such as `6002945040`), never by its number or its GraphQL `node_id`: in the body, or in the path when a dependency is removed; the issue the call acts on is the number in the path.
Giving the number where the `id` belongs answers `404 Not Found` with `{"message":"Not Found"}`, for sub-issues and dependencies alike.
The REST docs list every call below with `Accept: application/vnd.github+json` and `X-GitHub-Api-Version: 2026-03-10`.
github.com supports two versions: a request with `X-GitHub-Api-Version: 2021-01-01` answers `400 Bad Request` with `The following versions are currently supported: "2026-03-10" (most recent) and "2022-11-28".`
A request without the header gets `X-Github-Api-Version-Selected: 2022-11-28`, and the list of sub-issues answered the same under both; the other calls were tried under `2026-03-10` only, so an adapter that relies on these notes sends that version explicitly.
An issue's REST object carries `parent_issue_url`, `sub_issues_summary` (`total`, `completed`, `percent_completed`) and `issue_dependencies_summary` (`blocked_by`, `total_blocked_by`, `blocking`, `total_blocking`), so one `GET /repos/{owner}/{repo}/issues/{issue_number}` reads both relations' counts.

### Sub-issues (REST)

Add: `POST /repos/{owner}/{repo}/issues/{issue_number}/sub_issues` with `{"sub_issue_id": <id>}` answers `201 Created` with the parent issue (verified before in #373).
Add again: `422` with `An error occurred while adding the sub-issue to the parent issue. Issue may not contain duplicate sub-issues and Sub issue may only have one parent`, so an add is not idempotent, and a retried add tells a repeat from a failure only by reading the list or the parent.
An issue that already has another parent: `422` with `… Sub issue may only have one parent`.
With `{"sub_issue_id": <id>, "replace_parent": true}` the same add answers `201` and moves the issue; its timeline then shows `parent_issue_removed` and `parent_issue_added`.
The parent as its own sub-issue: `422` with `… Sub issue cannot be the same as the parent issue`.
An ancestor as a sub-issue of its descendant: `422` with `… Sub issue may not create a circular dependency`.
List: `GET /repos/{owner}/{repo}/issues/{issue_number}/sub_issues` answers `200` with the sub-issues as issue objects in their order, `per_page` at most 100, default 30.
Parent: `GET /repos/{owner}/{repo}/issues/{issue_number}/parent` answers `200` with the parent issue, or `404` with `{"message":"No parent issue found"}` when there is none.
Remove: `DELETE /repos/{owner}/{repo}/issues/{issue_number}/sub_issue` (singular `sub_issue`) with `{"sub_issue_id": <id>}` answers `200` with the parent; removing it again answers `404` with `{"message":"Not Found"}`, so a repeated remove reads as done only after a check.
Reorder: `PATCH /repos/{owner}/{repo}/issues/{issue_number}/sub_issues/priority` with `{"sub_issue_id": <id>, "before_id": <id>}` or `{"sub_issue_id": <id>, "after_id": <id>}` answers `200`, and the list shows the new order.
Both `before_id` and `after_id`: `422` with `Only the before_id or the after_id argument may be provided, but not both`; neither: `422` with `Either a before_id or after_id argument must be provided`.
Reordering an issue that is not a sub-issue of that parent: `404` with `{"message":"Not Found"}`.
The limits come from the docs and were not tried: at most 100 sub-issues per parent, eight levels of nesting, and in REST "The sub-issue must belong to the same repository owner as the parent issue"; the UI also adds sub-issues from other repositories.
Foedrum keeps sub-orders as Brewery issues under a Brewery order (ADR 0043 keeps them out of target repositories), so neither the cross-repository nor the cross-owner case was tried.
Closing a sub-issue counts it in the parent's `sub_issues_summary` whether it closes as completed or as not planned (#3 then #4 gave `completed` 1 of 2, then 2 of 2).

### Dependencies (REST)

Add "blocked by": `POST /repos/{owner}/{repo}/issues/{issue_number}/dependencies/blocked_by` with `{"issue_id": <id of the blocking issue>}` answers `201 Created` with the blocked issue.
There is no write for "blocking": "A blocks B" is written as "B is blocked by A".
Add again: `422` with `An error occurred while adding the blocking issue to the issue. Validation failed: Target issue has already been taken`.
An issue blocked by itself: `422` with `… Validation failed: Target issue cannot be the same as the source issue`.
A direct cycle (B blocked by A while A is blocked by B): `422` with `… Validation failed: this dependency would create a cycle where the target is already blocked by the source`.
A longer cycle is accepted: with A blocked by B and C blocked by A, B blocked by C answered `201`, so GitHub does not catch every cycle in a plan.
A blocking issue in another repository of the same owner is accepted (Brewery #6 blocked by `EdwinBekaert/foedrum#18` answered `201`, and was removed again).
List: `GET /repos/{owner}/{repo}/issues/{issue_number}/dependencies/blocked_by` and `GET …/dependencies/blocking` answer `200` with issue objects, `per_page` at most 100, default 30.
Remove: `DELETE /repos/{owner}/{repo}/issues/{issue_number}/dependencies/blocked_by/{issue_id}` answers `200` with the blocked issue, and answered `200` again when the link was already gone, so a remove is idempotent, unlike a sub-issue's.
`issue_dependencies_summary` counts only open blockers in `blocked_by` and all of them in `total_blocked_by`: with its one blocker closed, #3 read `{"blocked_by":0,"total_blocked_by":1, …}`.
The docs state no limit on the number of dependencies.

### GraphQL

GraphQL needs no version header; its mutations take `node_id`s, and `addSubIssue` also takes `subIssueUrl`.
The `Issue` fields `parent`, `subIssues`, `subIssuesSummary`, `blockedBy`, `blocking` and `issueDependenciesSummary` read both relations in one query, which cost 1 point.
Mutations: `addSubIssue(issueId, subIssueId | subIssueUrl, replaceParent)`, `removeSubIssue(issueId, subIssueId)`, `reprioritizeSubIssue(issueId, subIssueId, afterId | beforeId)`, `addBlockedBy(issueId, blockingIssueId)` and `removeBlockedBy(issueId, blockingIssueId)`.
`addBlockedBy`, `removeBlockedBy` and `reprioritizeSubIssue` were tried and behave as their REST calls.
A failed mutation answers HTTP `200` with `"data":{"addBlockedBy":null}` and the REST message in `errors[0].message` (`type` `VALIDATION`), so the HTTP status alone does not tell a GraphQL write's success from its failure.

### What a person sees

`gh issue view` shows `parent:`, `sub-issues:`, `blocked-by:` and `blocking:` rows (for #3: `parent: EdwinBekaert/foedrum-brewery#2`, `blocked-by: …#4`, `blocking: …#5`).
Each change is a timeline event: `sub_issue_added`, `sub_issue_removed`, `parent_issue_added`, `parent_issue_removed`, `blocked_by_added`, `blocked_by_removed` and `blocking_added`.
A cross-repository link adds such an event to the other repository's issue as well, so it is visible there.
According to GitHub's docs, the sidebar's **Relationships** item shows and edits the links, a blocked issue carries a "Blocked" icon on the Issues page and on project boards, and a parent shows its sub-issues' progress; the browser view was not opened in this spike.

### Rate limits

The REST primary limit is 5,000 requests per hour for a user; each create answered `X-Ratelimit-Resource: core` with `X-Ratelimit-Remaining` down by one.
GraphQL has 5,000 points per hour (`X-Ratelimit-Resource: graphql`, the `rateLimit` field gives `cost`, `remaining` and `resetAt`).
The secondary limits from the docs: at most 100 concurrent requests, 900 points per minute for REST and 2,000 for GraphQL (most REST `POST`, `PATCH`, `PUT` and `DELETE` requests and a GraphQL mutation count 5 points, a read 1), and "no more than 80 content-generating requests per minute" and "no more than 500 content-generating requests per hour", with some endpoints lower.
Each sub-issue and dependency write is documented as one that "may result in secondary rate limiting" when done too quickly.
No response header counts the content-creation limit; it shows only as a `403` or `429` with a message, and `retry-after` when present.
GitHub's guidance is writes one at a time, at least one second apart, and after a limit waiting `retry-after`, else until `x-ratelimit-reset` when `x-ratelimit-remaining` is 0, else at least a minute, and then backing off.
That is GitHub's advice, not what Foedrum's client does: how it handles a rate limit today is in [polling](polling.md) ([ADR 0052](../../adr/0052-github-reads-rate-limit-pauses-and-the-polling-interval.md)).
Applying a plan of n sub-orders with d links costs n creates, n sub-issue adds and d dependency adds: at one per second, a plan of 20 sub-orders with 20 links takes about a minute and stays under 80 per minute.
In a first run of these tries, one add (#6, then under #3, to #4) gave no answer before the batch passed 120 s; repeated alone it answered `422` with `… Sub issue may only have one parent` in 0.7 s, and #6's parent was still #3, so that add had not landed (gh has no deadline of its own).
Whether a write that times out can land later was not seen; the list or the parent tells afterwards.
