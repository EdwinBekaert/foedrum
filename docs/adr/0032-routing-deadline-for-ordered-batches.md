# 0032. A routing deadline for Ordered batches

Date: 2026-10-16 · Status: Accepted, amended by [0064](0064-test-first-recipes-when-onblocked-and-a-red-proof-required.md) (routing may skip steps whose when is false) · Amends [0025](0025-batch-lifecycle-stuck-reminders-and-rewind.md) and [0027](0027-supervisor-lost-and-stalled-attempts.md)

## Context
Invariant I1 says every non-terminal batch has exactly one pending action with a deadline. An Ordered batch had none: `batch.ordered` set no deadline, and the batch got one only when it was routed (`step.scheduled`) or entered Conditioning (`batch.waiting`). The property tests of #14 had to exempt Ordered from I1 (#98). An order whose routing never happens (the router crashed, a label was never read, the engine restarted between `batch.ordered` and `route`) sat in Ordered forever without a word, and I5 could not catch it because it had no deadline to miss. That breaks the engine rule that every wait has a deadline and a batch never sits silently.

## Decision

### `batch.ordered` sets a routing deadline
- `batch.ordered` carries a required `routeBy`, like `step.scheduled` carries `deadlineAt`. The Ordered lane keeps it: `{ kind: 'ordered', routeBy }`.
- The engine command `order` (`batchId`, `order`, optional `parentBatchId`) appends it, and `decide` sets `routeBy` to `now` plus the routing interval `routingMs` from its context, as it sets reminders from `reminderMs`. `batch.ordered` is no longer a `record` command: the deadline is the engine's to set, not the caller's. The supervisor shell's `routingMs` defaults to 1 hour.
- The store's `deadlines` index holds the routing deadline in the batch's own row, the one a Conditioning or Stuck reminder uses (step id `''`). `batch.waiting` replaces it with a reminder, `step.scheduled` ends it (routing always schedules the recipe's first step in the same command), and `batch.cancelled` clears it.

### Past the deadline, the batch is Stuck on routing
- When the routing deadline of an Ordered batch is due, the supervisor issues the new engine command `unrouted`, in the place ADR 0027 gives a due deadline (before expired leases and stalls). `decide` makes the batch Stuck with the new reason `{ kind: 'routing', deadlineAt }`, and its reminder from then on, so the human hears of it and keeps hearing of it.
- A batch Stuck on routing offers `retry`, `recipe` and `cancel`. It has no step to `skip`, `answer` or `rewind` to.
  - `retry` routes it again: `batch.resumed` (`action: 'retry'`) carries a new `routeBy`, and the batch goes back to Ordered with that deadline for the intake to route. The store sets it in the batch's row.
  - `recipe` chooses its recipe, as from any Stuck lane: it brews the recipe's first step.
- I5 now covers Ordered batches: one past its routing deadline is Stuck within one supervisor tick, like a brewing batch past an attempt's deadline.

### Lanes
ADR 0025's lane table changes in two rows:

| Event | Allowed while the batch is |
|---|---|
| `batch.stuck` | brewing or stuck with a step's reason; ordered or stuck on routing with `routing` |
| `batch.resumed` | stuck, when its options offer the action; with `routeBy` exactly when it retries a batch Stuck on routing |

The guard refuses a step's reason for a batch Stuck on routing and a `routing` reason for one Stuck at a step, so a reminder repeats the reason it reminds of.

### I1
I1 keeps its wording; its note reads "for Ordered batches: a routing deadline; for Conditioning and Stuck batches: a reminder deadline". The I1 property has no exemption left.

## Consequences
- `batch.ordered` and `batch.resumed` changed shape, and `StuckReason` has a seventh kind; the JSON Schema changes with them. There is no stored state from before this change outside tests.
- The polling intake (ADR 0008, milestone M1; [#103](https://github.com/EdwinBekaert/foedrum/issues/103)) orders batches through `decide`'s `order` command and routes Ordered batches, including those a retry sends back.
- `foedrum status` shows an Ordered batch with its routing deadline and a batch Stuck on routing as "not routed by …".
- A routing interval per Brewery, like the reminder interval (ADR 0027), is left open: one interval per supervisor and per caller of `decide` for now.

## Alternatives considered
- **Keep the exemption in I1:** the smallest change, but it keeps the one silent wait the engine rules forbid, and the cases that leave a batch Ordered (a crashed router, an unread label, a restart) are exactly the ones nobody notices.
- **Let `record` append `batch.ordered` with a caller's `routeBy`:** no new command, but every caller would carry its own routing interval, and the time policy would leave `decide`.
- **A reminder on Ordered instead of a deadline:** an Ordered batch would nag but never reach a lane a human acts on; Stuck already offers what they need (route again, choose a recipe, cancel) and repeats its reminder.
- **Retry by routing straight from Stuck (`route` allowed in the Stuck lane):** no deadline on the resume, but between the retry and the router's answer the batch would again wait with no deadline of its own.
- **A new event to send a batch back to Ordered:** one more event type, file placement and fold case for what `batch.resumed` with a `routeBy` says.
