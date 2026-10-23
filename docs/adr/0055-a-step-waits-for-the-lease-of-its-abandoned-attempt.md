# 0055. A step waits for the lease of its abandoned attempt

Date: 2026-10-17 · Status: Accepted · Amends [0044](0044-batch-leases-held-by-the-driver-and-one-command-log.md) (when a driver starts a scheduled attempt) and [0051](0051-chaos-runs-on-the-real-driver-with-two-drivers-and-a-terminal.md) (what the chaos check `nothingLeftWaiting` lets wait) · Amended by [0124](0124-foedrum-takeover-hands-a-batch-to-another-driver-as-a-recorded-command.md) and [0126](0126-foedrum-resume-opens-a-finished-attempt-s-session-in-its-worktree.md)

## Context
Invariant I2 allows one live lease per step. [ADR 0044](0044-batch-leases-held-by-the-driver-and-one-command-log.md) says an attempt's lease keeps the next holder of the batch from starting the step beside it. [ADR 0051](0051-chaos-runs-on-the-real-driver-with-two-drivers-and-a-terminal.md) has the heartbeat stop renewing the lease of an attempt that the log shows finished or abandoned. Nothing stopped a driver from starting the next attempt of a step while such a lease was still live.

The two-driver chaos run found the gap, on seed 1348138455 (#150). Stuck abandoned `implement#3` (its deadline had passed), and the tick stopped its run. The run did not end, so its lease stayed live for up to one lease (5 minutes by default). A human `retry` in that window scheduled `implement#4`, and the next drive started it straight away: two live leases on one step. A real runner's stop can take as long, because it kills a process tree and waits for it.

## Decision
- **A driver starts no attempt of a step while another attempt of that step holds a live lease**, whichever driver owns that lease. The attempt stays scheduled, and a later drive starts it once that lease has been released (the run ended) or has expired. `driveNow` reads the live leases once per pass (`src/engine/driver.ts`). Waiting is not a refused start.
- **The wait lasts one lease at most.** Only an attempt that is finished or abandoned can hold such a lease (a step schedules no new attempt while one runs), and the heartbeat no longer renews one (ADR 0051).
- **The waiting attempt's deadline keeps running.** A step whose deadline is shorter than what is left of that lease goes Stuck with `deadline_passed` before the attempt starts. That is intended. The step could not start in time, a run that may still be alive holds it, and the wait has a deadline like every other wait. It is also what happens when a step's deadline passes while no driver runs.
- **The chaos check `nothingLeftWaiting` gets a third exception**, next to ADR 0051's two (a batch that a driver that is down holds, and a batch that a terminal command changed in that move). The exception is a scheduled attempt whose step has a live lease of an attempt that the log shows finished or abandoned. `nothingOverdue` still holds that attempt to its deadline.

## Consequences
- I2 holds after Stuck and a retry, also with two drivers. Seed 1348138455 passes, and so do 1,000 runs of `test/chaos/drivers.test.ts`.
- After a retry, the next attempt may start up to one lease later than before (5 minutes by default). For a step whose deadline is much longer than that, the delay does not matter. A brewer whose deadline is shorter than the lease sees the batch Stuck again instead.
- Unit tests in `test/unit/driver.test.ts` cover the wait: it ends when the lease expires and when the run ends, a lease of another batch or step does not hold the step back, and a deadline shorter than the lease makes the batch Stuck.

## Alternatives considered
- **Release the abandoned attempt's lease when the tick stops its run.** Rejected: the run may still be alive, and the lease is what keeps a second attempt of the step from running beside it (I2).
- **Refuse the `retry` while the old lease is live.** Rejected: the human's command is valid, and a refusal would make them wait and try again by hand. The driver waits for them.
- **Keep the waiting attempt's deadline from running until it starts.** Rejected: it would change `decide`, the supervisor and the events for an edge case. A wait without a deadline is what the engine rules forbid ("every wait has a deadline").
