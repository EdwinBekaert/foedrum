# 0196. A later tasting round follows any earlier round that reviewed

Date: 2026-10-25 · Status: Accepted · Amends [0190](0190-a-later-tasting-round-reviews-the-change-since-the-round-before.md) (which earlier round a later one reviews the change since)

## Context
ADR 0190 gives a lens step's later round the change since the round before, but only after an earlier round of the same step sent the batch back by a findings route.
In a parallel group the route of one blocking child sends the whole group back, and every child runs again ([ADR 0168](0168-a-parallel-group-runs-its-lens-steps-side-by-side.md)): a child that approved in round 1 then re-reads the whole change, the noise ADR 0190 is meant to stop.
So does a lens step that runs again because a check's `onFail` route went back past it ([ADR 0069](0069-check-steps-run-the-repositorys-commands-in-an-attempt-of-their-own.md)).
The review of #500 found it.

## Decision
- **An earlier round is any earlier attempt of the same lens step in the batch that reviewed**: one that succeeded with a verdict (`approve` or `changes`), or ended blocked by findings, whatever sent the batch back.
- **The latest such attempt before the round counts**, and a retry or an attempt after an answer still belongs to the round it continues, as in ADR 0190.
- **A failed, cancelled or lost earlier attempt reviewed nothing** and does not count: the round reviews the whole change.
- **The guards of ADR 0190 stay**: no second input when the commit that round reviewed is not recorded, is in another repository, is not on the line to HEAD, when a merge of the base came after it, or when git cannot tell; the prompt then says why.
- **The fixed text names the round** without saying it sent the change back, since an approving round did not.

## Consequences
- A group child that approved, and a lens that runs again after an `onFail` route, review only the change since they last looked.
- A defect an approving round missed in code it reviewed is not looked for again, as ADR 0190 already accepts for a round that asked for changes.

## Alternatives considered
- **Any earlier finished attempt, whatever its outcome:** rejected. A failed or cancelled attempt reviewed nothing, so the change since it is no smaller part of what is left to review.
- **Only the round that sent the batch back (ADR 0190 as written):** rejected. It leaves every other child of a group re-reading the whole change on each round.
