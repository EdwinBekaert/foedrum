# 0328. One batch's error stops no other's work in the supervisor or the drive

Date: 2026-11-06 · Status: Accepted · Amends [0327](0327-a-pass-over-one-batch-s-effects-that-throws-stops-no-other-batch.md) (the supervisor and the drive go the same way, and a driver says nothing of a batch that is not its own, and says a failure once), [0250](0250-the-supervisor-is-one-tick-the-commands-own-the-interval.md) (a throw for one batch in those passes no longer reaches `tick_failed`), [0099](0099-a-rejected-run-end-is-blocked-on-the-environment-not-a-failed-tick.md) (a runner whose start throws ends as one whose end rejects), [0168](0168-a-parallel-group-runs-its-lens-steps-side-by-side.md) (a lost attempt's lease also stays while its batch cannot be read) and [0027](0027-supervisor-lost-and-stalled-attempts.md) (not every expired lease is released: a lost attempt's stays while its batch cannot be read or its `lose` throws) · Amended by [0335](0335-a-batch-that-keeps-failing-is-marked-after-an-hour-and-stuck-when-a-reading-hides-its-deadline.md)

## Context
ADR 0327 kept one batch's error inside the pass over the effects, and left the supervisor and the drive to #870. They run first in a driver's tick, so a throw for one batch there stopped every batch before any effect, and `a tick failed: <error>` named none. Nobody has seen this happen: the review of #868 found it by reading the code.

A guard alone would have made some things worse. `driveNow` loops while anything moved and sets `moved` before an attempt starts, so a guard that catches and goes on would try the same attempt for ever, and nothing would renew the leases. `planTick` is one pure function over all batches, so one throw lost every batch's deadlines. And it lists every expired lease but those it keeps, so a batch that threw would have its lost attempt's lease released with no `lose` issued, the wait ADR 0168 exists to prevent.

## Decision
- **Each pass guards each batch.** A throw for one batch is reported as `batch_failed`, naming the batch and the pass (`supervisor`, `runs`, `drive`, `cleanup`), and the others go on.
- **The supervisor's core stays pure.** `planTick` returns what failed, per batch, and the shell reports it. A batch that threw gets no command that tick, so a deadline it could not read is not passed over for a lesser command.
- **Two leases stay.** The expired lease of a lost attempt whose batch threw is kept for the next tick. So is one whose `lose` threw in `decide`, which was released before this.
- **A batch that threw is set aside for the rest of that drive**, and what it moved before it threw does not count, so a drive ends and says it once. The next drive tries it again. It is set aside per batch: a parallel group's children after the one that threw do not start in that drive, and their deadlines cover them.
- **A run's stop that throws is tried again on the next tick**, also a stop at a pause's `stopAt`, which is noted only once it did not throw.
- **`driver.close()` stops every run and lets its lock go**, whichever stop throws.
- **A throw after the start is recorded ends at once**, as a run whose end rejects does (ADR 0099): when the rest of its start, its limits or `runner.start` throw, the attempt has no run, so it is blocked on its environment at the next step boundary, `run_failed` says why, and its lease goes. Left alone it would wait out its lease, be lost and retried, and most likely throw again, spending its attempts on a cause `attempts_exhausted` does not name.
- **The reading of an attempt's end is inside its `try`.** When it throws, the end is reported and its lease stays until it expires, so the supervisor loses the attempt, as for an end whose record throws (#278).
- **An ended batch's cleanup stays queued until it ran.** No later look at the store would clean it. It has a pass of its own, so a clean drive of that batch does not call it recovered.
- **A driver says nothing of a batch that is not its own**: one it does not take, or one another driver holds. This amends ADR 0327's consequence that a driver reports a batch it does not hold, and covers `batch_effects_failed` too, so a `foedrum brew` of one order is quiet about the others. The supervisor says what it acts on, as its `acts` has it: a driver's own batches and the free ones.
  A driver also says the failures of the runs it runs, and of their ends, whoever holds their batch by then, since those are its own processes.
- **One line until something changes.** A batch and pass that keep failing are said once, and again when the message changes or after they recovered. A run of the pass over its batches to its end that no longer fails on it says `batch_recovered`, once, also for a run of a batch another driver holds by then. For the drive it is said only of a batch that still brews unpaused: one that went Stuck or was paused is not read, so its line goes unsaid. The line says the pass did not fail on the batch, not that it reached the same reading: in the supervisor, a batch that left the state the failing reading was for, as when a person cancelled it or the tick gave it another command, is said to read again, and so is a brewing batch whose drive stopped earlier at a closed usage window. When the reading fails again it is said again. This decides only what is printed, so this decision leaves it. This covers `batch_effects_failed`, and ADR 0327 left it to this issue. It decides only what is printed, so it stays in the driver's memory, as the flush watch does (ADR 0027), and a restart says each failure once more. An attempt's end whose reading throws is said each time, since each end comes once.
  `effect_failed` and `command_failed` still say every failure, which #883 can take up.
  Two runs of one batch's parallel group whose stops throw different messages alternate, so such a batch prints two lines per tick; this decision leaves that as it is.

### What stays a stop
Traced for this decision, and tested where a test says so:

- **A state-branch stop** rejects the tick. `StateBranchStopError` comes only from the state branch's start and flush, and in a driver only the supervisor flushes, after its per-batch part and outside any guard. Tested with a batch throwing in the same tick.
- **Ctrl+C** is read between ticks: the driver takes no signal. `serve` and `brew` read it, and `wireDriver`'s `visibilities.read(signal)` runs after the inner tick. The only signals in `driver.ts` are the deadline controllers of the effects, so no per-batch guard can catch `signal.reason`.
- **A lost lease is no throw**: `claim` and `heartbeat` read `hold.kind === 'other'` and report `batch_lost`. Tested.
- **A lost lock is not seen in a tick at all**: `lock.held` is read only at the start. This decision changes nothing there.
- **A fault of the store** inside a guard is reported against the batch being visited, as ADR 0327 decided. The tick's own uses of the store (the heartbeat, the lists of leases and due batches, the look at the ended batches) have no guard and report `tick_failed`, and that tick says nobody recovered.
- **`runner.progress`** is unguarded in the heartbeat: in every runner it is map lookups and an object, so no path throws today. In the supervisor's reading it is inside the guard.

## Consequences
- One broken batch no longer stops another's start, end, deadline, lease or cleanup.
- A batch that throws on every pass still has no deadline of its own for that, and its status comment and labels wait when the throw is in its effects. A throw in the drive leaves its attempt scheduled and its deadline fires. A throw in the supervisor's reading of a brewing batch's deadline hides that deadline itself, so an attempt can run past it.
- So CLAUDE.md's exception to "a batch must never sit silently" stays, narrowed, and that line of CLAUDE.md is reworded after the merge: a batch whose reading throws on every pass, in the effects or the supervisor, has one line in the driver's output until it changes or recovers. What a person sees beyond that line, and whether such a batch goes Stuck, is the open issue #883.
- No Brewery needs a migration and none of its files change: no event is added, and the notices are only printed.

## Alternatives considered
- **Wrap `supervisor.tick()` and `drive()` whole:** rejected. The tick's other batches would still stop, and a wrap around `supervisor.tick()` would catch the state-branch stop.
- **Count a throw as moved:** rejected. A drive would spin in one tick, with no lease renewed.
- **Lose the attempt whose start threw, through its lease:** rejected for the reasons ADR 0099 rejects it for a run that rejects.
- **One failure line per pass, as ADR 0327 had it:** about 720 lines an hour for one batch, which buries the rest of the output.
- **A guard per source in `combineEffects.due`:** left to #883. A plain catch there would make `recordAfter` and `noneDue` read an unreadable source as nothing due, so a batch would be let go and `order.decomposed` recorded after an unread `planIssues`.
