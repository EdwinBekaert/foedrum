# 0433. The intake holds an issue while an issue it is "blocked by" on GitHub is open

Date: 2026-11-26 · Status: Accepted · Amends [0217](0217-a-recipe-s-concurrency-and-the-open-order-limit-hold-what-the-intake-starts.md) (a fourth hold beside the recipe's `concurrency`, the open-order limit and the touches limit) and [0208](0208-orders-are-claimed-in-rank-order-by-arrival-unless-a-person-moved-one-with-foedrum-rank.md) (the walk of the queue skips an issue its blockers hold). Sits beside [0211](0211-the-intake-starts-ready-sub-orders-at-their-order-s-rank-once-their-blockers-merged.md), which holds a sub-order by the ledger.

## Context
GitHub lets an issue be "blocked by" other issues, in any repository. Foedrum honoured such links only inside one order's plan, where a sub-order waits for its blockers' merges as the ledger records them (ADR 0211), and wrote them for the plan's sub-issues; it read them only to avoid adding one twice.
For separate issues it did not: the intake claimed each target issue that passed its filter, and ordered each labelled Brewery issue, by rank, whatever it was blocked by. Issues that must wait for each other because they change the same files could start side by side, and a person ordered each one by hand after the last merge (#1178, from the frictions of 2026-11-19).

## Decision
- **The hold.** The intake neither claims a target issue nor orders a Brewery issue while an issue it is "blocked by" on GitHub is open. It takes the issue at the first pass after its last blocker closed.
- **Closed is closed.** A blocker closed as not planned counts as closed: the person who closed it decided it will not come. A blocker in another repository counts the same way, named by its repository.
- **A hold like the limits'.** The held issue keeps its place in the queue and holds no other issue: the walk skips it and goes on. It is said once with serve's existing line, `<repo>#<n> waits: blocked by #3 (open)`, a blocker of another repository as `owner/name#3`. Nothing is written on the held issue, which is not claimed, and nothing is recorded in the store: the next pass reads GitHub again, so a restart holds the same.
- **Read only when counted.** The open-issues listing carries `issue_dependencies_summary.blocked_by`, the count of open blockers. The links (`GET …/issues/{n}/dependencies/blocked_by`) are read, in any repository, only for an issue whose listing counts some, and only when the walk reaches it with a free slot and no limit holding it. The links say which blockers are open, as the listing alone cannot name them. The read is a dependency call, so it sends API version `2026-03-10` as [0287](0287-the-sub-issue-and-dependency-calls-send-api-version-2026-03-10.md) decides for them.
- **A read that fails holds nothing and starts nothing.** The pass reports it, leaves the issue for the next pass and goes on with the rest.
- **Sub-orders are left to the ledger.** An issue labelled `foedrum:sub-order` is held by its plan's blockers (ADR 0211), never by GitHub's links, so it is never held twice. The plan's own links on GitHub are the same blockers written for people to see.
- **Why a sub-order waits for a merge and an issue for a close.** A sub-order's blocker is done when its pull request is merged, so that it starts from a base that holds the change: the ledger knows that merge before GitHub closes the blocker's issue. An issue's blocker is a separate issue, which its own pull request closes when it merges; the close is the only fact the intake can read for an issue it does not own, and a person who closes it by hand has decided as well.

## Consequences
- Issues that must come one after another can be labelled at once: only the first is claimed, and each next one at the first pass after the last merge closed its blocker.
- A blocker closed by hand, completed or not planned, releases what it blocks at the next pass.
- A held issue costs one conditional read of its links per pass (a 304 costs no rate limit), and one of its events, as any candidate's.
- `foedrum rank` still places a held issue at its rank; `foedrum status` shows no line for it, since status reads the store alone and nothing is recorded.

## Alternatives considered
- **Record the hold in the store.** A second record of what GitHub already says, which a person's edit of the links would leave out of step.
- **Drop the held issue from the queue.** It would lose its place, and `rank` could not place it.
- **Read the links of every listed issue.** One request per issue per pass for the issues that have none, where the listing's count says it in the answer already read.
- **Hold sub-orders by GitHub's links too.** A sub-order's blocker closes only when its pull request merges and GitHub closes its issue, a step later than the merge the ledger records, and every sub-order would be held twice.
