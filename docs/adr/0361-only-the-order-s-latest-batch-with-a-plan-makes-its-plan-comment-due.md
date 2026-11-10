# 0361. Only the order's latest batch with a plan makes its plan comment due

Date: 2026-11-10 · Status: Accepted · Amends [0233](0233-a-plan-is-an-out-doc-whose-paths-the-engine-checks-shown-as-one-comment-per-order.md) (a batch's plan revision is no longer due once a later batch of the order has a plan)

## Context
An order has one plan comment, which every batch of the order edits through the ledger ([ADR 0233](0233-a-plan-is-an-out-doc-whose-paths-the-engine-checks-shown-as-one-comment-per-order.md)).
A revision of a batch is due when the text it renders now is not the one its own latest revision recorded.
The driver asks every batch of the state for its due effects on each pass, ended or not.
An upgrade that changes what `renderPlan` writes (#658, [ADR 0285](0285-an-approved-plan-becomes-brewery-sub-issues-through-the-ledger.md), [ADR 0318](0318-a-plan-lens-s-findings-go-back-to-the-plan-step-and-the-plan-comment-lists-the-review-notes-left.md) each did) makes the text of every batch with a plan differ from its latest revision.
For an order that was brewed again, the first pass after the upgrade edited the order's comment with an earlier batch's older plan, and it stayed so until the later batch's next revision (#825).

The issue asked that only the latest batch, or a batch not ended, make the comment due.
"Not ended" does not hold here: `batchEnded` counts a batch on tap only once it has pull requests and all of them ended, and an approved plan of a split order is on tap with none.
Such a batch does not stop the order from being brewed again (`busy` refuses a new batch only while the earlier one is ordered, brewing, conditioning or Stuck, or has a pull request with no recorded end).
So the issue's wording would still put an approved plan back over a later batch's plan.

## Decision
A batch's plan revision is due only while no batch of the same Brewery issue ordered after it has a succeeded plan (`laterPlanned` in `planDue`, `src/engine/plan-comment.ts`).
The order of the batches is the order they were ordered, as the state holds them, which `orderRevision` already reads.
A later batch with no plan yet (still planning, or of a recipe with no plan step) does not silence an earlier one, since the comment still shows the earlier plan; a cancelled batch with no later plan follows an upgrade as before.
Whether a batch has ended plays no part.

## Consequences
- An upgrade that changes the plan comment's text edits each order's comment once, with the plan of the order's latest batch that has one.
- An order whose comment shows an earlier batch's plan today, from a pass before this change, keeps it until the latest batch's next revision; that revision is due at the first pass after an upgrade that changes the text, or when its plan, Gate or Review changes.
- No Brewery file changes, so a Brewery has nothing to migrate.

## Alternatives considered
- **The latest batch, or any batch not ended**, as #825 asked: leaves the bug for an approved plan of a split order, which never counts as ended.
- **Only the order's latest batch, with or without a plan**: a re-brewed order whose new batch has not planned yet would leave its comment unrendered after an upgrade, though it still shows the earlier plan.
