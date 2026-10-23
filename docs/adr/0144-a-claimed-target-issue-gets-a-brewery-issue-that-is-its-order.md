# 0144. A claimed target-repository issue gets a Brewery issue that is its order

Date: 2026-10-23 · Status: Accepted · Amends [0043](0043-target-repository-issues-as-a-work-queue-claimed-by-a-ref.md) (what the order of a claimed issue is, the effects of its batch), [0072](0072-the-status-comment-edits-as-revisions-in-the-ledger.md) (no status comment on the Brewery issue of a claimed issue yet), [0154](0154-lane-labels-on-the-order-s-issue-and-the-status-comment-s-path-line.md) (no lane label on it yet), [0071](0071-the-openpullrequest-action-two-effects-of-the-batch.md) (a claimed batch's pull request is titled after and closes the target issue, not its order), [0068](0068-the-intake-in-foedrum-serve-brewery-orders-and-routing-by-label.md) (which Brewery issues the intake orders), [0050](0050-the-intake-of-target-repository-issues.md) (what the order of a claimed issue is, its release, how `status` and `stuck` name it) and [0105](0105-foedrum-order-orders-an-issue-again-as-a-human-command-recorded-on-batch-ordered.md) (ordering a claimed issue again, and its Brewery issue)

## Context
Until now a claimed target-repository issue **was** the order: its batch is `<alias>-<n>`, kept apart from the Brewery's own orders ([ADR 0050](0050-the-intake-of-target-repository-issues.md)).
The analyze recipe of #373 needs a private place for an order's plan, its questions, the sign-off and its sub-issues, and the target issue should show only the claim marks.
The discussion of #373 decided that every claimed target issue gets a **Brewery issue** that is its order, and that issues are never created in target repositories ([ADR 0043](0043-target-repository-issues-as-a-work-queue-claimed-by-a-ref.md) stands).
#387 builds that, and left these questions:

- **When the Brewery issue is made, and how its number is known.** The batch is ordered when the claim is won, before any Brewery issue exists. Making the issue is an external side effect, so it goes through the ledger (invariant I4), and only the driver applies effects, under the batch's lease ([ADR 0044](0044-batch-leases-held-by-the-driver-and-one-command-log.md)).
- **The batch's id.** It is a folder on the state branch, chosen when the batch is ordered.
- **What the pull request names.** The Brewery is private (2026-10-23, #374).
- **The release, and ordering again.** What happens to the Brewery issue when the claim ends, and which one a batch ordered again gets.

## Decision

### The Brewery issue is an effect of the batch
- The claim effects of a claimed batch gain **`order.issue`**, after the three marks, so a Brewery issue that fails to open never holds off the marks that keep other Breweries away (`claimEffectsDue`, `src/engine/issue-claims.ts`).
- It opens an issue in the Brewery's repository with **only the target issue's title**, read when it applies, and a body that links the target issue (`The order of owner/name#<n>, which this Brewery claimed. …`) and carries the effect's key as a hidden marker. The target issue's text stays where it is: brewers read it from there, as before.
- It is found by that marker in an issue that the Brewery's own identity opened, closed ones included (`IssueMarks.findIssue`; on GitHub the issues of the Brewery listed with `state=all&creator=<login>`), as the claim comment is found by its marker (ADR 0050). An issue someone else opened never counts, since keys are predictable.
- **The Brewery issue's number is the ledger's result for `order.issue`**, and no event repeats it. `claimOrderOf` (`src/engine/claim-orders.ts`) reads it from the folded state: the batch's own, or the one an earlier batch of the same issue opened. A result that is no positive integer names none, and the effect refuses to record one.

### The batch keeps its name; its order is the Brewery issue
- The batch id stays `<alias>-<n>`, and `<alias>-<n>-<k>` when the issue is ordered again (ADR 0050). It is chosen before the Brewery issue exists, and renaming it once the issue is open would move its folder on the state branch.
- `batch.ordered` records the claimed target issue, as it did (`order: { issue, repo }`), so the fold still keeps the batch apart from the Brewery's orders and sub-orders.
- `foedrum status` and `foedrum stuck` name the batch's issue **`#<order> (<alias>#<n>)`**, and `<alias>#<n>` until its Brewery issue is open (`orderName`); the alias is the batch id's first part, which has no hyphen. `foedrum replay` keeps `owner/name#<n>`.
- The intake never orders that Brewery issue as one of the Brewery's own, whatever labels a person gives it (`isBreweryOrder`), and `foedrum order #<order>` is refused with the issue to order instead: `issue #200 is the order of acme/web#123; order web#123 again` (`orderRefusal`).

### The pull request is the target repository's
Its pull requests are opened in the target repository and close the target issue (`Closes owner/name#<n>`), as they did; neither their title nor their body names the Brewery issue.

### The release follows the target issue
- When every pull request of the batch merged, the target issue is done, and the release closes the Brewery issue too: **`release.order`**, after the release comment and before the ref goes (ADR 0050 keeps the ref last).
- A cancelled batch, or one whose pull request was closed, leaves the target issue open and assigned, and its Brewery issue open with it.
- `claimStanding` counts `release.order` among the release's effects, so `foedrum order` waits for it as it waits for the rest ([ADR 0105](0105-foedrum-order-orders-an-issue-again-as-a-human-command-recorded-on-batch-ordered.md)).
- A Brewery issue a person deleted is **gone** (GitHub answers 410, or 404 for one that is not there): closing or reopening it records `gone` instead of failing. The driver stops a batch's effects at the first that fails, so a deleted issue would otherwise hold off the rest of the release, and the claim ref would never go, as `release_ref` already counts a gone ref as released.

### Ordering again orders the same Brewery issue
A batch of an issue that an earlier batch opened a Brewery issue for opens none: its order is that issue, and it reopens it (**`order.reopen`**, in the place of `order.issue`). The reopen is found done while the issue is open, so it changes nothing then, and it also reopens an issue a person closed by hand.
When the reopen finds the issue gone, or a release found it gone, the new batch opens a Brewery issue of its own (`order.issue`), so a batch ordered again always has a Brewery issue that is there.

### No status comment or lane label on it yet
The Brewery issue of a claimed batch gets neither a status comment nor a lane label yet, as the claimed target issue gets neither ([ADR 0072](0072-the-status-comment-edits-as-revisions-in-the-ledger.md), [ADR 0154](0154-lane-labels-on-the-order-s-issue-and-the-status-comment-s-path-line.md)); the status comment and lane label of every other Brewery issue's batch are unchanged.
Both skip a claimed batch, whose issue number is the target issue's; #413 gives them the Brewery issue once it is open.

## Consequences
- Every claimed target issue that `serve` marks gets one Brewery issue, linked to it, which later work hangs the order's plan, questions and sub-issues on (#373).
- A claimed batch makes one or two more requests to GitHub, and finding its Brewery issue lists the Brewery's issues by its own login, page by page. A Brewery with more than 5,000 such issues fails the find (the reads' page limit, ADR 0052); the effect then fails and is retried.
- GitHub links the Brewery issue to the target issue it names; only people who can see the Brewery see that link.
- A Brewery whose repository refuses new issues (issues turned off, a token that cannot write there) fails `order.issue` on every pass, reported each time, and the batch's later effects, its pull request's among them, wait behind it, as they wait behind a claim mark that fails.
- Not yet: the status comment and lane label of a claimed batch (it still has neither, and the Brewery issue is where they belong, #413), routing by the Brewery issue's label (routing still reads the target issue's), and sub-orders as sub-issues of the Brewery issue (#373).

## Alternatives considered
- **Name the batch after the Brewery issue (`<order>-<k>`):** the issue would have to exist before the order, made by the intake or the terminal outside the driver's lease, or the batch renamed once it does.
- **A new event that records the Brewery issue's number:** the ledger already records it as the effect's result; a second record of one fact could disagree with it.
- **Make the Brewery issue in the intake or in `foedrum order`:** neither applies effects; the driver is the one writer of effects through the ledger (ADR 0044).
- **Close the Brewery issue with every release:** a cancelled or closed batch leaves the target issue open for a person to decide, and its order should stay in view with it.
- **Copy the target issue's text too:** two copies that drift apart; the target issue stays the one source of what was asked.
