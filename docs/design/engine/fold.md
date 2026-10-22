# The fold and the guard

Current state is a pure fold over events (`src/engine/fold.ts`): orders and sub-orders (one repository each) with their dependencies, batches with their lane, steps, attempts, rewinds, bottles, observed releases and the idempotency ledger.
An issue is in at most one of `orders` and `subOrders`, and every batch is listed on exactly one of them.
Breakdowns have one level ([work breakdown](../intake/work-breakdown.md)): only an order is decomposed.
Several sub-orders of one order may target the same repository; the fold orders nothing among them beyond the recorded dependencies.
A new breakdown replaces the order's sub-order list and dependencies; the sub-orders it leaves out are marked `cancelled`, never deleted, and keep their batches, and a later breakdown that lists one again un-cancels it.

The fold records what the events say and leaves the batch lifecycle to the state machine; it only requires attempts to go from scheduled to started to finished.
It throws an `InvalidLogError`, naming the index and type of the event and the reason, when an event:

- refers to a batch, step or attempt the log never created (an applied effect refers to the batch or attempt its key names), repeats one, or takes an attempt out of that order;
- opens a bottle or applies an effect twice (invariant I4);
- decomposes a sub-order, lists an order as a sub-order, or moves a sub-order to another order.

Such a log is corrupt.
The command layer refuses these events before they are appended; the fold's check is the last line of defence.
Crash recovery is replay.

The guard before append (`src/engine/admit.ts`) checks each event against the folded state: its schema, the lanes it may come from ([the batch lifecycle](../engine/lifecycle.md)), and then the fold itself.
The fold marks the unfinished attempts of a batch abandoned when it gets Stuck, and the guard refuses a late start or finish of one.
It also refuses two things the fold records as they come ([ADR 0025](../../adr/0025-batch-lifecycle-stuck-reminders-and-rewind.md)): a breakdown that moves a sub-order with batches to another repository, and a bottle that lists a sub-order that does not exist, targets another repository or has no batch on tap ([ADR 0013](../../adr/0013-single-repo-sub-orders-bottles-and-releases.md)).
