# 0217. A recipe's concurrency and the open-order limit hold what the intake starts

Date: 2026-10-26 · Status: Accepted · Amends [0068](0068-the-intake-in-foedrum-serve-brewery-orders-and-routing-by-label.md) (the Brewery's limit gains a recipe's and an open-order limit), [0208](0208-orders-are-claimed-in-rank-order-by-arrival-unless-a-person-moved-one-with-foedrum-rank.md) (part 3 is these two limits; overlapping `touches` follows #388), [0211](0211-the-intake-starts-ready-sub-orders-at-their-order-s-rank-once-their-blockers-merged.md) (the queue skips what a limit holds) and [0053](0053-recipe-files-reach-the-engine-brewer-steps-in-a-line-first.md) (`foedrum status` loads the recipes while a limit can hold)

## Context
The Brewery's `concurrency` is the only limit on what starts: a pass orders and claims its queue in rank order until the batches Ordered or Brewing reach it ([ADR 0068](0068-the-intake-in-foedrum-serve-brewery-orders-and-routing-by-label.md), [ADR 0208](0208-orders-are-claimed-in-rank-order-by-arrival-unless-a-person-moved-one-with-foedrum-rank.md)), with the ready sub-orders in the same queue ([ADR 0211](0211-the-intake-starts-ready-sub-orders-at-their-order-s-rank-once-their-blockers-merged.md)).
#532, part 3 of #239, adds two limits: a recipe's `concurrency`, at most that many of its batches at once, never above the Brewery's; and the Brewery's open-order limit, how many orders may be in progress at once, default 3.
Its third limit, that two sub-orders whose plan `touches` overlap never run side by side, needs the `touches` field that mash (#388) adds, and is not this record.
ADR 0208 settled that a rank orders what the limits let start, and never overrides them.

## Decision

### Where a limit acts
- **In the pass's walk of its queue.** An entry a limit holds is skipped: it stays in the queue at its rank, and the walk goes on to the next entry, so a held order never leaves a slot empty while a later one could take it. The next pass finds it at the same place.
- A target issue the open-order limit holds is not claimed.
- A recipe is known before ordering only for a Brewery issue or a sub-order, from its one `recipe:<name>` label in the pass's listing. A claimed issue's recipe is its Brewery issue's label, which exists only after the claim ([ADR 0156](0156-a-claimed-order-is-routed-by-its-brewery-issue-s-recipe-label.md)), and a retry sends a batch back to Ordered. So the pass's **routing** holds a batch too: it does not route a batch to a recipe at its limit, and reports that once per batch and reason, as it reports a batch it cannot route (`unrouted`).
- The checks are one pure module (`src/engine/limits.ts`): the walk, the routing and `foedrum status` read them from the folded state, the listing and the limits.

### What counts against a recipe's limit
- As the Brewery's `concurrency` counts its batches Ordered or Brewing (ADR 0068): a recipe's batches Brewing (`Batch.recipe`), the Ordered batches the pass will route to it (their Brewery issue's one label as listed), and those the same walk ordered before.
- A batch that comes back to Brewing from Conditioning or Stuck (a retry, a `continue`, an answer) is not refused, as the Brewery's `concurrency` does not refuse one today. "Never above a limit" holds for what the intake orders and routes: a person who moves a batch on can put a recipe above its limit, and the intake then starts no more of it until it is below.

### A person's choice is not held
- The limits hold what the engine starts by itself, the intake.
- `foedrum recipe` for a Stuck batch, and `foedrum brew`, are a person's choice to brew now, and pass, as `brew` already passes the Brewery's `concurrency`.
- The cost: the hold is the intake's, not `decide`'s, so a later writer that issues `route` by itself is not held unless it reads the same module. Today the intake and `brew` are the only ones; the router (#227) is to route through the intake's pass.

### A held route
- The batch stays Ordered and keeps its Brewery slot, and its routing deadline stands: past it, it goes Stuck on routing as it does now (ADR 0032), so the wait has a deadline and a person hears of it.
- Only claimed batches and retries reach a held route, since the walk does not order a Brewery issue or a sub-order its recipe cannot take.

### Never above the Brewery's
- A recipe's `concurrency` is a whole number from 1 to 20, optional; without it the recipe has no limit of its own.
- The Brewery's `concurrency` caps it, since the walk never orders past the free capacity: a recipe's 5 under a Brewery's 2 is 2.
- It is not refused at load: recipes load apart from foedrum.jsonc, and Foedrum's defaults ship with it.

### An order in progress
Decided by the maintainer on 2026-10-26.
- An order is a Brewery issue's or a claimed target issue's, by `orderKey` through `orderOfBatch`: a sub-order's batch belongs to its order, and a claimed issue and its Brewery issue are one order.
- It is **open** while the Brewery has work left on it: a batch of it, its own or a sub-order's, is Ordered, Brewing, Conditioning or Stuck, or a sub-order of its latest breakdown has no batch yet, ready or blocked.
- So a paused order counts (its batches keep their lanes, and a `continue` must not put the Brewery above the limit), a stopped one counts (Stuck `stopped`), and so does any Stuck one, until a person moves it on.
- An order whose batches are all On tap or cancelled, with no sub-order left, does not count, even with its pull request open and waiting on a person. A decomposed order whose remaining sub-orders wait for that merge does.
- An order whose latest batch is cancelled does not count: ADR 0211 starts none of its sub-orders.
- The cost: a sub-order blocked by a closed pull request keeps its order open until a person orders the blocker again or cancels the order, and so does a sub-order whose own issue a person closed, which the intake never orders (ADR 0211), until a new breakdown leaves it out or the order is cancelled.

### What the open-order limit holds
- Only a new order: one with no batch yet. A ready sub-order of an open order is never held by it, since finishing the orders that started is the point.
- A sub-order still meets its recipe's limit and the free capacity.

### The settings
- `openOrders` in foedrum.jsonc, beside `concurrency`: 1 to 20, default 3 (decided by the maintainer, 2026-10-26), with no check against `concurrency`.
- With `concurrency` above 3 and orders without sub-orders, the default brews at most 3 at once until `openOrders` is raised.
- `concurrency` in a recipe file, beside `testFirst`.

### No new event
What a limit holds is a function of the folded state, the listing and the config, as the ready set is (ADR 0211's reason against a recorded "ready"). A restart computes the same holds.

### Where it shows
- `foedrum status` prints, above the board as it prints the usage windows, one line per limit that holds now, read from the store, foedrum.jsonc and the recipes, without the network: a recipe at its limit, with the batches that hold it (`recipe nip: 1 of 1 at once (12-1); its next orders wait`), and the open-order limit once it is reached, with the open orders.
  It reads only what is Brewing for a recipe, since the labels of the Ordered batches are on GitHub.
  When foedrum.jsonc or the recipes do not load, it prints the board as before and one line that says the limits could not be read, and exits 0.
- **This amends [ADR 0053](0053-recipe-files-reach-the-engine-brewer-steps-in-a-line-first.md) for `status` alone:** a read-only command never loaded the recipes, and `status` now loads them, with foedrum.jsonc, while some order is open (a batch Ordered, Brewing, Conditioning or Stuck, or a sub-order of a breakdown left without a batch), the only time a limit can hold. The cost is one read of the recipe files and Foedrum's defaults per `status`; with no open order it reads only the store, as before.
- `foedrum status --watch` stays as it is: a load each second for its redraw is a cost the plain board does not have, and a later issue can bring the lines there.
- `serve` prints a `held` intake notice once per issue and reason, as it prints `unrouted` once.
- A held order's rank does not change.

### Next
The third limit (#566) comes with #388's `touches`: two ready sub-orders whose `touches` overlap do not run side by side.

## Consequences
- With a recipe's `concurrency` of 1, a second order for it waits while the first brews, a later order of another recipe takes the free slot, and `foedrum status` says why the second waits.
- A Brewery with the default `openOrders` starts a fourth order only once one of three is On tap or cancelled, while their sub-orders still start.
- A Brewery with `concurrency` above 3 brews fewer orders side by side than before, unless it raises `openOrders`.
- `foedrum.jsonc` gains `openOrders`, and a recipe gains `concurrency`; existing files stay valid.
- One pure module, one intake notice; no event, no fold field.

## Alternatives considered
- **Hold the start in the driver:** the batch would take a Brewery slot and sit Ordered or between steps, and an order behind it that the limit lets start would not get the slot.
- **Stop the walk at the first held entry:** strict rank, but slots stay empty while later orders could brew.
- **The queue alone:** a claimed issue's recipe is unknown when it is claimed, and a retry comes back to Ordered, so both would pass a recipe's limit.
- **Refuse `route` in `decide`:** one place for every writer, but `foedrum brew` routes through it too, and would be refused after it ordered, leaving an Ordered batch for the intake; `brew` passes the Brewery's `concurrency` and should pass a recipe's.
- **Hold a person's `recipe` too:** a person who chooses a recipe for a Stuck batch means it now; the limits pace what the engine starts by itself.
- **Renew `routeBy` while a route is held:** a write for a rare case, which would also hide from a person a batch that waits for long.
- **Refuse a recipe whose `concurrency` is above the Brewery's when `serve` loads both:** an error for a setting that only loses effect, and Foedrum's default recipes could not set one.
- **An open pull request counts as an open order:** a limit on work waiting for review. Three unmerged pull requests would stop the Brewery.
- **A Stuck order does not count:** three Stuck orders would no longer stop the Brewery, but a `retry` of each would then put it above the limit.
- **Default `openOrders` to the larger of 3 and `concurrency`:** a Brewery that raised `concurrency` keeps its pace, but the default would not be one number to read.
