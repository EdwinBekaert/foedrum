# 0211. The intake starts ready sub-orders at their order's rank, once their blockers merged

Date: 2026-10-26 · Status: Accepted · Amends [0208](0208-orders-are-claimed-in-rank-order-by-arrival-unless-a-person-moved-one-with-foedrum-rank.md) (the queue gains ready sub-orders, and `rank` accepts a started order with sub-orders left) and [0013](0013-single-repository-sub-orders-bottles-and-releases.md) (a `code` blocker is done when its pull request is merged, not stacked on its branch)

## Context
An order can be decomposed into sub-orders with "blocked by" dependencies (`order.decomposed`, [ADR 0013](0013-single-repository-sub-orders-bottles-and-releases.md)), but nothing starts them: the intake never orders a sub-order, and `rank` refuses one ("its plan ranks it").
#239 settled on 2026-10-25 that sub-orders rank in their plan's order, and that **a blocker is done when its pull request is merged**, never only On tap, so that what it blocks starts from a base that holds the change.
#531 is part 2 of #239: the ready sub-orders of all orders start in rank and plan order, within the Brewery's free capacity.
Nothing produces sub-orders yet (mash, #388 and #389), so this is built on recorded `order.decomposed` events.
The limits on what runs side by side (a recipe's `concurrency`, the open-order limit, overlapping `touches`) are #532.

## Decision

### The ready set
- A sub-order is **ready** when it is in its order's latest breakdown, has no batch yet, and every sub-order it is blocked by is **done**.
- It is a pure function of the folded state (`readySubOrders`, `src/engine/ready-set.ts`): no new event, no model.
- A sub-order left out of a later breakdown is cancelled ([ADR 0014](0014-interactive-refinement-plugin.md)) and is never ready; its order's latest breakdown no longer lists it.
- A sub-order that has a batch is never ordered again by the intake, whatever became of that batch: a person retries or orders it.

### When a blocker is done
- A blocker is done when one of its batches recorded a pull request `merged` (`pull_request.ended`, which the intake records for every batch on tap), or when it is in a bottle whose pull request one batch recorded `merged`.
- A pull request still open, or ended `closed`, or a batch only On tap, is not done.
- **Bottles:** nothing opens a bottle yet. A bottle's pull request is recorded ended through the batches it bottles: whoever opens bottles puts the bottle's pull request in each bottled batch's `batch.on_tap`, so the intake records its end per batch as it does today. No new event.
- **`code`** now waits for the blocker's merge, not for its branch: a sub-order starts from a base that holds the change, and its pull request never stacks on another that may still change or close.
- **`release`** is left out of this record: a sub-order with a `release` blocker is never ready here. #538 adds the release signal (a `release.observed` of the blocker's repository after its merge); until then such a sub-order waits, and nothing produces one.

### Where it starts them
- In the intake pass: its queue gains the ready sub-orders beside the new orders, within the same free capacity.
- A sub-order is ordered with `{ kind: 'order', order: { issue }, parentBatchId }`, the parent being its order's latest batch, as `<issue>-1`, and routed as any Brewery issue's batch, by its `recipe:` label ([ADR 0068](0068-the-intake-in-foedrum-serve-brewery-orders-and-routing-by-label.md)).
- The recorded breakdown is the authority to start it: no author or label check, as `isBreweryOrder` makes for an order.
- A sub-order starts only while the pass's Brewery listing shows its issue open: a sub-order a person closed is never brewed, and is not cancelled either, unless a new breakdown leaves it out.

### Their place in the queue
- A sub-order sorts at its order's place: the order's rank if it has one, else its order's arrival.
- The order's arrival is its issue's `created`, read from the Brewery listing the pass already reads; an order whose issue the pass did not list open (closed, or the listing failed) starts no sub-order in that pass.
- The sub-orders of one order go in their plan's order (`subOrders` of the latest `order.decomposed`).
- A started order's next sub-order goes ahead of a new order of the same place; a higher-ranked new order still goes first.

### `rank`
- `rank` of an order with a batch is accepted while its latest breakdown still has a sub-order without a batch, so a person can move a started order's remaining sub-orders; it is refused once none is left.
- A place counts orders, not sub-orders: an order whose ready sub-orders are three entries of the queue is one place.
- An order with sub-orders left but none ready now is still placed, at its arrival, so `rank` can move and print it.
- A sub-order itself is still refused: its plan ranks it.

### Holds
- `pause --all` orders nothing, as before ([ADR 0202](0202-pause-and-continue-hold-an-order-or-the-whole-brewery-at-its-next-convenient-point.md)).
- A ready sub-order of a paused order is not ordered: it would only take a slot and wait.
- A ready sub-order of an order whose latest batch is cancelled is not ordered: the order was cancelled.

### Nothing changes for orders without sub-orders
- A pass with no breakdown recorded builds exactly the queue it built before.

## Consequences
- The free slots go to the highest-ranked ready work across every order: when order A has ten sub-orders and one is ready, order B's ready ones take the other slots.
- A dependency costs a merge: a blocked sub-order waits for a person or the ruleset to merge its blocker's pull request.
- `rank` moves a started order's remaining sub-orders, so the Innkeeper (#227) can later set them through the same command.
- Whoever opens bottles has to list the bottle's pull request in each bottled batch's `batch.on_tap`.

## Alternatives considered
- **A blocker done when On tap.** Starts sooner, but the blocked sub-order branches from a base without the change, and a blocker whose pull request is closed would have let it start for nothing (#239 settled against it).
- **Keep `code` stacked on the blocker's branch.** Its pull request would carry the blocker's commits, and change when the blocker's review changes them.
- **An event that marks a sub-order ready.** A second record of what the fold already knows, written by the engine, which a restart could see out of step with the merges it follows.
- **`release` as merged plus a later `release.observed` now.** It needs the fold to order a release against a merge, which it does not keep; #538 adds it with the release signal.
- **Arrival from the order's first batch.** No listing needed, but `orderedAt` is when the order left the queue, not when it arrived, so a started order would rank behind orders that came after it; and it is absent on older batches.
- **Places that count sub-orders.** `rank X 2` behind an order with three ready sub-orders would land ahead of that whole order, not at place 2.
- **Order a closed sub-order's issue anyway.** The breakdown is the authority, but a person who closed the issue has dropped it, and brewing it would spend a slot on work no one wants.
