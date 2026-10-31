# 0285. An approved plan becomes Brewery sub-issues through the ledger

Date: 2026-10-31 · Status: Accepted · Amends [0281](0281-foedrum-approve-signs-off-a-plan-by-its-hash-and-puts-the-batch-on-tap.md) (an approval is applied as sub-issues and `order.decomposed`; the Gate section, the On tap line and the next step say so) and [0211](0211-the-intake-starts-ready-sub-orders-at-their-order-s-rank-once-their-blockers-merged.md) (the intake skips a ready sub-order whose issue is labelled `needs-refinement`)

## Context
Since ADR 0281, `foedrum approve` records `batch.approved` with the digest of the plan and puts the batch on tap, but nothing turns the plan into sub-orders: no issue is opened, and no `order.decomposed` is recorded, so the ready set of ADR 0211 never starts one.
#723 (ADR 0287) gave the Brewery's tracker the calls for it: open an issue with its labels, find one by a marker, add a sub-issue, add a "blocked by" link, and list both.
GitHub refuses a repeated add with `422` ([trackers](../design/intake/trackers.md)), so applying a plan twice, after a kill, must read before it writes.
A plan could also name `mash` as a sub-order's recipe, which would plan the sub-order again before anything is built; ADR 0234 neither allowed nor forbade it.

## Decision
- **The driver applies an approval as effects through the ledger** (`planIssueEffects`, `src/engine/plan-issues.ts`), one key per external write, for a Brewery batch with an approval whose order has no `order.decomposed` from that batch. The plan is the out doc of the attempt the approval names: the guard checked its digest at approve (ADR 0281), and a later plan is a new attempt and a new approve.
- **The effects, in their order:**
  - `plan.<id>.issue` for each sub-order, in the plan's order: a Brewery issue (never in a target repository, ADR 0043) with the sub-order's title, a body with what it builds, when it is done and why its recipe, its `recipe:<name>` label, and `needs-refinement` as well when the plan marks it not ready. Its key's marker is in the body, so a run killed after the write finds it in an issue its own login opened (ADR 0033, ADR 0144).
  - `plan.<id>.parent` once that issue is in the ledger: the issue added as a sub-issue of the order's issue, found first in the order's list of sub-issues, so a repeat is read back, never refused.
  - `plan.<id>.blocked-by.<on>` once both issues are in the ledger, for each dependency: the "blocked by" link, found first in the issue's list.
- **`order.decomposed` follows the last effect.** A source of driver effects may name events to record once every effect it gave for a batch is in the ledger (`recorded`); the driver records them under the batch's lease after the pass, as it ends an action's attempt (ADR 0071). The event lists each sub-issue with its repository, its touched paths and its plan entry's id, the plan's step and attempt, and every dependency by issue number. A kill after the last effect leaves the event to the next pass.
- **A sub-order's batch records where it came from**: `batch.ordered` of a sub-order the intake orders carries `plan`, the approved batch, the plan's step and attempt, and the entry's id, so a brewer can later read its plan entry (#591).
- **`needs-refinement` is the mark, and the label is where it lives.** The intake does not order a ready sub-order whose issue the pass's listing shows labelled `needs-refinement`, even with a recipe label, beside its check that the issue is open (ADR 0211); the ready set stays a pure function of the fold. A person removes the label once it is refined, or runs `foedrum mash` on it, which orders it by hand.
- **A sub-order's recipe builds, never plans.** A plan whose sub-order names `mash` or `mash-in` fails its attempt retryably, naming that sub-order's `recipe`, as any wrong field does (ADR 0233). A sub-order that needs more planning is marked not ready and corrected before approve (#589); a plan of two levels would be an issue of its own.
- **What a person sees**: the plan comment's Gate section names each sub-issue as `<id>: #<n>` as the ledger has it, after the approval; the status comment's On tap line adds the sub-issues once all are opened; the next step of a plan waiting for its review no longer says its sub-orders are ordered by hand.

Rejected: appending `order.decomposed` in the intake pass (the intake holds no batch lease, and the event belongs with the writes it records); recording the not-ready mark on the event (a person could then never lift it but by a new plan); the label check in the ready set (it would need the tracker's listing, which the fold does not have); a sub-order planned again by `mash` (two levels of plans, and of approvals, for one order).

## Consequences
- A plan of n sub-orders with d links costs n opens, n sub-issue adds and d link adds, each with a read before it, as `trackers.md` counts them.
- An order's sub-orders appear on GitHub one by one; until the last effect is applied, none of them is ready, since `order.decomposed` is not yet recorded.
- A sub-issue a person deletes before the event is recorded leaves its key in the ledger; the event still names it, and the intake never starts it, since it is not listed open.
- An older Foedrum cannot read `batch.ordered` or `order.decomposed` with their new fields.
