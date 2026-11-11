# The event store

The `EventStore` interface (`src/engine/event-store.ts`) hides the storage; its implementation on `node:sqlite` keeps seven tables under a schema version (`PRAGMA user_version`) with a migration per version: `events`, append-only through triggers but for the one delete the Cellarer's `forget` makes (below); `leases`; `batch_leases`; `pushed`, the state branch's pushed-through marker (the last event on the remote branch and the commit that holds it; it only moves forward); `out_docs`, the out doc text of each attempt until a flush puts it on the state branch, outside the log and never folded (ADR 0103); and two indexes of the events, maintained on append, so `replay` and `restore` rebuild them from a log (ADR 0011, ADR 0024).
`restore` appends events read from the state branch keeping their ids, after every stored event, and marks them pushed in the same transaction:

- `effects`: the idempotency ledger is the `effect.applied` events.
  Recording an effect appends one, keyed by the canonical JSON array `[batch, step, attempt, effect]` or `[batch, effect]` (`src/engine/effect-key.ts`), and the index holds each key once.
  A trigger on `events` fills it, so the database itself refuses a second event for a key (the failed insert leaves no row), and `replay` refuses a log that contains one.
  An effect is applied through `applyEffect` (`src/engine/effects.ts`): the ledger's result when it is recorded, else the target's when the target finds the effect by its key (an engine killed after applying it and before recording it), else the result of applying it now.
  So every effect carries its key to its target, where only an object Foedrum's own identity made counts as found (keys are predictable), and is due because of recorded events, so a restarted engine finds it due again with the same key ([ADR 0033](../../adr/0033-chaos-tests-effects-found-by-key-and-leases-at-start.md)).
- `deadlines`: the pending deadline of each step of a batch, and of the batch itself while it waits to be routed or for a reminder, so "batches past their deadline" is one indexed query (a batch's earliest).
  `batch.ordered` sets the routing deadline, and so does `batch.resumed` when a retry sends the batch back to Ordered ([ADR 0032](../../adr/0032-routing-deadline-for-ordered-batches.md)); `step.scheduled` sets its step's deadline and ends a routing deadline or a Conditioning or Stuck reminder; `batch.waiting` sets the reminder in place of a routing deadline; `batch.stuck` replaces every deadline of the batch with its reminder ([ADR 0025](../../adr/0025-batch-lifecycle-stuck-reminders-and-rewind.md)); `step.finished` clears its own attempt's deadline; `batch.on_tap` and `batch.cancelled` clear every deadline of the batch.

Events are validated against the zod schemas when appended and when read.
All writes go through `withTransaction` (`BEGIN IMMEDIATE`; rolled back on any throw; not nestable), in WAL mode with a busy timeout.
The store reads no clock: callers pass `now`.

**Forgetting a shelved batch** ([ADR 0380](../../adr/0380-the-cellarer-shelves-finished-batches-off-the-store-sweeps-old-temporary-files-and-expires-the-shelf.md)): `forget` deletes a batch's events, its ledger rows, kept out docs, deadlines and leases in one transaction, and records it in `shelving` with the month it was shelved in.
The delete triggers on `events` and the ledger refuse every delete but those of a batch in the transaction's `forgetting` table, which `forget` fills before its deletes and empties after them, so the ledger's guard (I4) holds for every batch the store keeps.
`expire` records the month before which the shelf is deleted, in `expiring`; a flush reads both, and `shelved` and `expired` clear them once its push went through ([the state branch](state-branch.md)).
Each forget counts in `forgets`, and a command log folds again from empty when that count changed, so the fold never holds a forgotten batch.
