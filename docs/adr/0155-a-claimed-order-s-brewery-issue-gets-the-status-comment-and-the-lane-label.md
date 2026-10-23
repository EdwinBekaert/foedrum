# 0155. A claimed order's Brewery issue gets the status comment and the lane label

Date: 2026-10-23 · Status: Accepted · Amends [0144](0144-a-claimed-target-issue-gets-a-brewery-issue-that-is-its-order.md) (the Brewery issue of a claimed batch now gets a status comment and a lane label), [0072](0072-the-status-comment-edits-as-revisions-in-the-ledger.md) (a claimed batch's first revision is due once its Brewery issue is recorded, not when the batch is ordered) and [0154](0154-lane-labels-on-the-order-s-issue-and-the-status-comment-s-path-line.md) (which issue a claimed batch labels, which batch labels it, and the link `foedrum brew` prints)

## Context
A claimed target-repository issue gets neither a status comment ([ADR 0072](0072-the-status-comment-edits-as-revisions-in-the-ledger.md)) nor a lane label ([ADR 0154](0154-lane-labels-on-the-order-s-issue-and-the-status-comment-s-path-line.md)): it keeps its claim comment and `foedrum:claimed`, since its lane is the private Brewery's business.
[ADR 0144](0144-a-claimed-target-issue-gets-a-brewery-issue-that-is-its-order.md) gave every claimed issue a Brewery issue that is its order, and left both effects skipping a claimed batch, because they wrote to `batch.issue` in the Brewery, which for a claimed batch is the target issue's number.
So a claimed order's progress showed nowhere on GitHub, while in the first trial on Foedrum (#374) the status comment and the label on the Brewery issue were how the maintainer saw a batch work (#413).

## Decision
- **The status comment and the lane label of a claimed batch go to its Brewery issue**, the one `claimOrderOf` reads from the ledger ([ADR 0144](0144-a-claimed-target-issue-gets-a-brewery-issue-that-is-its-order.md)), by the same revisions, keys, finds and applies as a Brewery issue's batch (`breweryIssueOf`, `src/engine/claim-orders.ts`).
- **Nothing is due before the ledger records that issue**: no revision waits on an issue that is not there, and neither effect ever writes to the target issue's number in the Brewery. The first revision of each is due once `order.issue` is recorded (or, for a batch ordered again, at once with the earlier batch's issue), and shows the lane the batch is in then: a batch that reached Brewing first never shows Ordered.
- A batch ordered again that found its Brewery issue gone has none until it records its own, and neither effect is due in between.
- **The target issue still gets neither**: it keeps only its claim marks (ADR 0050).
- **Only the latest batch whose order is that Brewery issue labels it** (`claimOfOrder`), as only the latest batch of a Brewery issue labels that one: a batch ordered again shares the Brewery issue of the batch before it, whose revisions are then never due again.
- Each batch has a status comment of its own there, as each batch of a Brewery issue has (ADR 0072).
- **`foedrum brew` prints the link to that comment**, on the Brewery issue, once its first revision is recorded.

## Consequences
- A claimed order's Brewery issue shows its lane in the Brewery's issue list and its status comment, path line included; the claimed target issue looks as it did.
- A claimed batch makes the requests of a status comment and a lane label (ADR 0072, ADR 0154), all to the Brewery.
- The status comment shows the text brewers wrote on the Brewery's own issue, never on another owner's repository, so ADR 0072's reason to give a claimed issue none still holds for the target issue alone.
- A comment or label applied after the release closed the Brewery issue still lands on it: GitHub takes both on a closed issue.

## Alternatives considered
- **Wait for the Brewery issue inside the effect** (due at once, failing until it is recorded): a failing effect on every pass, reported each time, for what is only a matter of order.
- **Put them on the target issue:** model-written text and the lane on another owner's repository at every step, which ADR 0072 and ADR 0154 refused.
- **Record the Brewery issue on the batch with an event:** the ledger already records it as `order.issue`'s result; ADR 0144 refused a second record of one fact.
