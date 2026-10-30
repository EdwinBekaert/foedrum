# 0257. Sub-orders whose touches overlap never brew side by side

Date: 2026-10-30 · Status: Accepted · Amends [0217](0217-a-recipe-s-concurrency-and-the-open-order-limit-hold-what-the-intake-starts.md) (a third limit holds what the intake starts)

## Context
ADR 0217 holds an entry of the intake's walk when its recipe's `concurrency` or the Brewery's open-order limit is full, and left a third limit for the `touches` field of a breakdown's sub-orders (`order.decomposed`, checked by [ADR 0233](0233-a-plan-is-an-out-doc-whose-paths-the-engine-checks-shown-as-one-comment-per-order.md)).
Two ready sub-orders whose `touches` overlap can still start side by side, and their pull requests then conflict (#566).

## Decision
- **A sub-order whose `touches` overlap those of a sub-order with a batch Ordered or Brewing is held**, as a full recipe holds one: it is skipped, keeps its place in the queue, and the walk goes on. The next pass finds it again, and starts it once the other's batch has left Ordered and Brewing.
- **An Ordered batch holds**, as a recipe's `concurrency` counts it (ADR 0217): its route can be held, by its recipe's `concurrency` or because its issue has no recipe label yet, and it stays Ordered over passes; once routed it brews. Counting only Brewing batches would let an overlapping sibling start beside it, and both would brew once it is routed.
- **The walk counts what it started.** A sub-order the same walk started holds the ones behind it, as one already Ordered or Brewing does. A held sub-order holds nothing and takes no recipe concurrency.
- **Which one waits:** the later in the walk, or the one with no batch when the other has one. A batch On tap, Conditioning or Stuck holds nothing.
- **An overlap** is a shared path, or a path under a folder the other touches (`src/engine` holds `src/engine/limits.ts`, not `src/engine-extra/x.ts`). Only sub-orders of one repository, compared without case, can overlap.
- **Sub-orders without `touches` are never held by this limit,** and hold none.
- **The fold keeps `touches`** in `SubOrder`, from the latest breakdown that lists the sub-order, so the check is a function of the folded state and a restart computes the same hold (as ADR 0217's "No event").
- **Where it shows:** the `held` notice reads `its touches overlap sub-order #<holder>'s, whose batch is ordered or brewing (touches)`, true of either lane, so the notice does not change when the holder is routed; `foedrum status` prints, after the open-orders line and above the board, one line per ready sub-order held: `sub-order #11 waits for sub-order #10 (10-1): their touches overlap` (`limitLines`).
- Not held, as in ADR 0217: a person's `foedrum brew` and `recipe`, and a batch that goes back to Brewing.

## Consequences
- Two sub-orders that share a file are brewed one after the other, so the second starts from a base that holds the first's change only once it merges, and does not conflict with a branch brewed at the same time.
- A sub-order whose issue never gets a recipe label holds its overlapping siblings until its routing deadline makes it Stuck (ADR 0032), where a person sees it.
- The limit holds nothing in a real run until a breakdown records `touches` on `order.decomposed` (#590): today only the field and its reader exist.
- A plan that lists a broad folder serialises its sub-orders; a plan should name files.
- `SubOrder` gains an optional `touches`; no event, no setting.

## Alternatives considered
- **Hold until the other's pull request merges:** safest, but it blocks the sub-order for the review time, not only the brewing; the order asks for the batch to leave Brewing.
- **Hold across different orders' sub-orders only when they are of one breakdown:** the same files conflict whoever asked, so the check compares every sub-order that brews.
- **Count only Brewing batches, and hold an Ordered one's route while an overlapping sibling brews:** it would also keep two from brewing together, but the walk would order both, and the second's batch would sit Ordered against its routing deadline for a reason the walk already knew.
- **Read `touches` from the event log at each check:** the fold already holds the breakdown, and a field there keeps the check pure.
