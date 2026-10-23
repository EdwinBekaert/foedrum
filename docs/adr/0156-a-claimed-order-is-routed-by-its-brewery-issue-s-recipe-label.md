# 0156. A claimed order is routed by its Brewery issue's recipe label

Date: 2026-10-23 · Status: Accepted · Amends [0068](0068-the-intake-in-foedrum-serve-brewery-orders-and-routing-by-label.md) (where the label of a claimed batch is read, which repositories a pass lists for routing, who chooses a claimed issue's recipe) and [0144](0144-a-claimed-target-issue-gets-a-brewery-issue-that-is-its-order.md) (routing by the Brewery issue's label, listed there under "Not yet")

## Context
The intake routes an Ordered batch by its issue's one `recipe:<name>` label ([ADR 0068](0068-the-intake-in-foedrum-serve-brewery-orders-and-routing-by-label.md)).
Since [ADR 0144](0144-a-claimed-target-issue-gets-a-brewery-issue-that-is-its-order.md), a claimed target-repository issue has a Brewery issue that is its order, opened by the driver after the claim marks, and `claimOrderOf` (`src/engine/claim-orders.ts`) gives its number.
`route` still read the labels of the target issue, in the public repository, so a person had to put `recipe:<name>` there to choose a claimed order's recipe.
In the first trial on Foedrum (#374) that label belonged on the Brewery issue, and putting it on the public issue was undone: which recipe brews an order is the Brewery's business, and the Brewery is private.
#414 moves the label, and asks what the pass must list to see it.

## Decision

### The Brewery issue's label routes a claimed batch
- A claimed batch is routed by the `recipe:<name>` labels of its Brewery issue (`claimOrderOf`: the batch's own, or the one an earlier batch of its issue opened), read from the Brewery's listing in the same pass; the target issue's labels never count (`route`, `src/engine/intake.ts`).
- The rules are every Brewery issue's: one label routes, two or a recipe the Brewery lacks are reported once with the reason, none waits for the routing deadline ([ADR 0032](0032-routing-deadline-for-ordered-batches.md)).
- Until the ledger records its Brewery issue, the batch waits unrouted, its routing deadline running as before; a driver that cannot open the Brewery issue leaves it Stuck on routing after an hour, where a person chooses a recipe.
- A Brewery issue the listing does not show (a person closed it, or the listing failed) leaves its batch waiting the same way.
- Labels still count only while a batch is Ordered (ADR 0068): relabelling the Brewery issue after routing changes nothing.

### The target issue's filter no longer gates routing
ADR 0068 left a claimed batch unrouted while its target issue no longer passed the repository's intake filter.
The filter chooses which issues a Brewery claims; once it claimed one, the order is its Brewery issue, and whether and how it is brewed is decided there.
So a pass no longer reads the target issue to route its batch, and a target issue that lost its filter labels, moved milestone or was closed routes like any other.
Stopping such a batch is a person's `cancel`, as for every order.

### What a pass lists
- The Brewery is listed when there is free capacity, as before, or when an Ordered batch waits for it: a Brewery order, or a claimed batch whose Brewery issue is recorded.
- A target repository is listed only when there is free capacity to claim in it; it is no longer listed for routing.
- The cost: none more than before. A claimed batch waiting to be routed without free capacity used to list its target repository on every pass, and now lists the Brewery instead, one conditional read (ADR 0052) that the Brewery's own Ordered batches already made. With free capacity the Brewery is listed anyway. A claimed batch whose Brewery issue is not open yet lists nothing for its routing.

### Who chooses the recipe of a claimed issue
ADR 0068 accepted that anyone who can label issues in a target repository chooses a claimed issue's recipe.
That is gone: only people who can label issues in the Brewery choose it, the same people who choose the recipe of the Brewery's own orders.

## Consequences
- The target issue of a claimed order carries only the intake filter's labels and the claim marks; `recipe:<name>` there is ignored.
- A Brewery's owner chooses a claimed order's recipe by labelling its Brewery issue, which `foedrum status` names as `#<order> (<alias>#<n>)`; until it is open, a person can still choose with `foedrum recipe` once the batch is Stuck on routing.
- A claimed order now waits for its Brewery issue before it can be routed: at least one driver tick after the claim, and the next pass after that. ADR 0068's routing "in the same pass that orders" holds only for the Brewery's own orders.
- The analyze recipe (#388), which a Brewery issue without a recipe label gets by default, reads the same place: a claimed order's Brewery issue.
- The chaos case of the intake (`test/chaos/intake.test.ts`) gives each claimed target issue the label `recipe:half` and its Brewery issue what the plan asks for, and routes a claimed batch only once its Brewery issue is recorded.

## Alternatives considered
- **Read both, the Brewery issue's label first:** a public label would still choose a recipe while the Brewery issue has none, and the trial of #374 showed it does not belong there.
- **Keep the filter check on the target issue:** the pass would go on listing every target repository with an Ordered batch only to read a fact the Brewery issue now owns, and an issue that dropped out of the filter would go Stuck on routing instead of brewing what its owner chose.
- **Copy the target issue's `recipe:` label to the Brewery issue when it is opened:** the public label would still choose, once, and two places would hold one choice.
- **Read the Brewery issue by number (`GET issues/<n>`) for each claimed batch:** one request per waiting batch and pass, where the Brewery's listing, conditional and usually already made, has them all.
