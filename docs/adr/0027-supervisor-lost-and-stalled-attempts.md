# 0027. The supervisor: lost and stalled attempts, reminders and the flush retry

Date: 2026-10-15 · Status: Accepted · Amends [0024](0024-state-branch-layout-outbox-and-divergence.md) and [0025](0025-batch-lifecycle-stuck-reminders-and-rewind.md) · Amended by [0032](0032-routing-deadline-for-ordered-batches.md), [0044](0044-batch-leases-held-by-the-driver-and-one-command-log.md) and [0047](0047-the-claude-brewer-runner-its-stream-endings-and-progress.md)

Amended 2026-10-28 (#616): the supervisor is one tick. Its own loop, timer and interval are gone; the commands that run the driver (`foedrum serve`, `foedrum brew`, and the takeover of `foedrum resume`) own the interval between ticks.

## Context
The supervisor (#10) is the one liveness mechanism of the engine: leases, deadlines, stall detection and reminders (architecture §5). [ADR 0025](0025-batch-lifecycle-stuck-reminders-and-rewind.md) gave it two commands, `expire` (a deadline passed, invariant I5) and `remind` (a Conditioning or Stuck reminder is due), but left out what an expired lease or a stalled brewer does to a batch. A lease names its attempt in a free-text `attemptKey`, and the store could list only the leases still alive, so nothing could tell which attempt an expired lease held. [ADR 0024](0024-state-branch-layout-outbox-and-divergence.md) asks the supervisor to retry a failed flush of the state branch "with a deadline that raises the batch's attention", and asks the engine to generate batch ids that pass the path-segment schema; #7 handed both to this issue.

## Decision

### A pure tick
- `planTick` (`src/engine/supervisor.ts`) takes the folded state, the batches past their deadline from the store's `deadlines` index, the expired leases, the runner's progress signals and the time, and returns engine commands for `decide` and the leases to release. It never builds events: `decide` does, and the guard checks them, so the supervisor cannot do what the state machine refuses.
- At most one command per batch and tick, in this order: a due deadline (`expire` for a brewing batch, `remind` for a Conditioning or Stuck one), then an expired lease (`lose`), then a stall (`stall`). A deadline wins, so a batch past its deadline is Stuck within one tick (I5) even when its lease also expired. The folded state has the last word: a batch the index lists whose attempt is not due gets nothing.
- The shell (`src/engine/supervisor-loop.ts`) runs one tick with an injected clock and store; the commands that run the driver call it on their own interval (amended 2026-10-28, #616). It decides the commands one after another, each against the state the earlier ones led to, and appends each command's events in a transaction of its own: a command that `decide` refuses (`refused`) or that throws (`command_failed`, for example from a broken recipe or an invalid progress signal) is reported and skipped, and the other batches still reach their deadlines (I5). It then releases the expired leases and flushes the state branch, also when the tick itself failed. `tick()` waits for the tick in flight, so ticks never overlap, whoever calls them. A tick that throws rejects, and the command reports it and runs the next one; a `report` that throws is ignored, so it cannot end a tick.

### A lost attempt is retried
- A lease's `attemptKey` is the canonical JSON text `["batchId","stepId",attempt]` (`src/engine/attempt-key.ts`), written exactly as `JSON.stringify` writes it, like an effect key. The store lists `expiredLeases(now)` next to `currentLeases(now)`.
- When the lease of a started attempt that still runs has expired, its process is lost: the supervisor issues `lose`. `decide` records `step.finished` with `failed { retryable: true }` and the reason (`the attempt was lost: the lease of <owner> expired at <time>`), then schedules another attempt while the recipe's `maxAttempts` allows (`Recipe.mayRetry`), else makes the batch Stuck with `attempts_exhausted`. It never takes an `onFail` route: that route is for a failed check, and a lost process says nothing about the code. A lost attempt is handled like a cancelled one, with its reason kept.
- `retryMode` decides how the next attempt starts, not whether there is one: the runner (#11) resumes the lost attempt's session (recorded in its `step.started`) or starts a fresh one. Nothing in `step.scheduled` changes.
- Every expired lease is released, whether its attempt was lost, has not started (its deadline covers it), finished, was replaced, was abandoned, or is unknown. An expired lease means nothing any more (architecture §4.1).

### A stalled attempt gets the batch Stuck
- A recipe step may set `stall: { turns, minutes }` (brewers-and-recipes §1), asked through `Recipe.stall(stepId)`. The runner reports, per running attempt, when it last wrote a file or committed and how many turns it took since, through a small `ProgressSource` interface; tests use a fake.
- An attempt without progress for `turns` turns or `minutes` minutes, whichever comes first, is stalled: the supervisor issues `stall`, and `decide` makes the batch Stuck with the new reason `{ kind: 'stalled', stepId, lastProgressAt, turnsWithoutProgress }`, which offers retry, skip, recipe, rewind and cancel. Getting Stuck abandons the attempt (ADR 0025); the runner stops its process.
- A stall goes to a human rather than to another attempt: a brewer that makes no progress usually lacks something another attempt does not have either.

### Reminders
- Conditioning and Stuck reminders repeat at the shell's `reminderMs` (default 2 days), passed to `decide` as before. I1 holds after every tick: every Conditioning or Stuck batch has its next reminder ahead.
- The interval is one per supervisor for now. Architecture §4.3 makes it configurable per Brewery and recipe; a per-recipe interval needs a recipe field and a `Recipe` accessor first, which this decision leaves open.

### The flush retry
- Every tick flushes the state branch after its own events, so events that a failed flush left in the local store do not wait for a step boundary that may never come. A flush that throws (other than `StateBranchStopError`) counts as failed.
- The flush deadline (default 10 minutes) is the engine's, not a batch's: when flushes have failed for that long, the supervisor reports `flush_overdue` once, naming when they started failing. This amends ADR 0024's "raises the batch's attention": the push failure belongs to no single batch, and making batches Stuck would append more events that cannot be pushed either.
- When the flushes started failing is kept in the supervisor's memory, not in the event store: it drives only a notice, and nothing about a batch. An engine that restarts during an outage starts the flush deadline again, so the notice can come later, never sooner. This is in-process state of the shell, like its cache of the folded state, not engine state; the engine rule's exceptions (leases and the pushed-through marker) stay as they are.
- A `StateBranchStopError` (another engine pushed, the branch was rewritten) stops the engine: `tick()` rejects with it, and the command that runs the driver stops without another tick (amended 2026-10-28, #616).

### Batch ids
- The engine names a new batch `<issue>-<n>` with the first `n` no batch uses (`src/engine/batch-id.ts`): digits and one hyphen, at most 33 characters, so it always passes `PathSafeId`.

### Commands
ADR 0025's engine commands gain `lose` and `stall`. Both need the attempt to be the latest of its step, started, and neither finished nor abandoned, and the batch to be brewing.

## Consequences
- I5 and I1 are checked after every tick in a test that runs the shell against an in-memory store with a controllable clock, at several tick intervals, with expiring leases, stalls and reminders mixed in.
- `StuckReason` has a sixth kind; the JSON Schema changes with it. There is no stored state from before this change outside tests.
- Recipe files (#52) must provide `stall` per step, and the runner (#11) must write leases with `attemptKey.encode`, report progress through `ProgressSource`, stop the process of an abandoned attempt, and apply `retryMode` when it starts the next attempt.
- A lease written with any other key is released when it expires and loses nothing; the deadline still covers its attempt.
- The `flush_overdue` and `refused` notices go to an injected `report` until a status surface (#37) shows them.

## Alternatives considered
- **A lost attempt as `finish` with `cancelled`:** no new command, but the reason would be lost, and the attempt was not cancelled by anyone.
- **A lost attempt as `finish` with a retryable `failed`:** the same event, but `finish` takes the `onFail` route once attempts are used up, which sends a check's failure back to an earlier step for a process that merely died.
- **Retry a stalled attempt like a lost one:** keeps batches moving, but spends attempts on a brewer that is going nowhere, and hides the stall from the human who can fix its cause.
- **Make every batch with unpushed events Stuck when the flush deadline passes:** visible on the board, but the Stuck events could not be pushed either, and a network outage would put the whole Brewery in the Stuck lane.
- **Read leases only while alive and treat a missing lease as lost:** a started attempt whose runner never took a lease (or a database rebuilt after a crash, which keeps no leases) would be lost at once; deadlines already cover it.
