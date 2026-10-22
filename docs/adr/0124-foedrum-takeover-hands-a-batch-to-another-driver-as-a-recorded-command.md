# 0124. `foedrum takeover` hands a batch to another driver as a recorded command

Date: 2026-10-22 · Status: Accepted · Amends [0044](0044-batch-leases-held-by-the-driver-and-one-command-log.md) (takeover, left for later; a driver's start and a takeover each read the batch lease in the transaction that appends)

## Context
[ADR 0019](0019-interactive-sessions-and-one-command-layer.md) has one driver per batch at a time, and makes taking over a batch that another driver holds "an explicit command": the current driver stops at the next step boundary, and the handover is recorded as an event. [ADR 0044](0044-batch-leases-held-by-the-driver-and-one-command-log.md) built the batch leases and the stop at the boundary (a driver whose renewal finds another driver's live lease starts nothing more in the batch and applies none of its effects), and left the command for later. [ADR 0123](0123-foedrum-brew-drives-one-batch-under-an-owner-of-its-own.md) built `foedrum brew`, which refuses a batch another driver holds and points at this one (#335).

Until now a lease changed hands only once it had expired, a whole lease after its holder's last renewal. Each driver relied on that. It renews a batch's lease, then starts an attempt or applies an effect, and within those few moments nobody else can hold the batch. A takeover gives the lease away at once, so these windows open up:

- **A start after the lease moved.** A driver claims the batch, then records `step.started` in a transaction of its own. If a takeover comes in between, the driver that lost the batch would start one more attempt in it.
- **Two starts of one attempt.** With worktrees, a driver leases the attempt, makes its worktree, then records its start. If the batch moves in between, the new holder would lease that same attempt again over the first lease and make the same worktree beside it. [ADR 0055](0055-a-step-waits-for-the-lease-of-its-abandoned-attempt.md)'s wait only covers another attempt of the step.
- **One effect applied twice.** A driver renews the lease before each effect, then awaits it for up to its deadline (below a lease). If the new holder applies the same effect in that time, the two calls overlap, both find nothing on the target, and both apply it ([ADR 0033](0033-chaos-tests-effects-found-by-key-and-leases-at-start.md)).

## Decision

### The commands
- **`foedrum takeover <batch> [--as <name>]`** is a command of the registry that changes state (`TakeoverCommand`). It puts the batch's lease to the driver `--as` names, else to the Claude Code session's (`session-<id>`, as `foedrum brew` names it, [ADR 0123](0123-foedrum-brew-drives-one-batch-under-an-owner-of-its-own.md)). Neither is a mistake of the command line (exit 2). `--as cellar` hands the batch back to the Cellar, which takes every batch it may hold.
- It takes no driver lock and drives nothing. The new owner's lease lasts one lease (`defaultLeaseMs`). The driver of that owner renews it at its next tick (the Cellar, or a `foedrum brew` under that owner). Without one, the lease expires within a lease, as any lease of a driver that is gone does.
- **`foedrum brew <issue> --take`** does the same before it drives, when another driver holds the batch, instead of refusing it. Without another holder, it brews as before. `--take` is the registry's first flag: an option without a value.
- It is **refused** for a batch that was never ordered, for one that has ended (on tap or cancelled), for one whose lease no other driver holds alive ("no driver holds batch b; foedrum brew drives it"), and for one the new owner already holds.

### The event
`batch.taken_over` records the handover in the batch's log, and therefore on the state branch:

| Field | What |
|---|---|
| `by`, `via` | who ran the command, and from which surface ([ADR 0019](0019-interactive-sessions-and-one-command-layer.md)) |
| `from` | the owner whose live lease it took |
| `to` | the owner it gave the lease to |
| `until` | when `from`'s lease would have expired: its effects end before that |

- The command decides on the lease as the transaction that appends reads it. `CommandLog.issue` takes the command as a function of that transaction too, so `from` and `until` cannot be stale. The new lease is written in the same transaction ([ADR 0044](0044-batch-leases-held-by-the-driver-and-one-command-log.md)'s one command log).
- The guard allows the event in a live lane (ordered, brewing, conditioning, Stuck). The fold keeps the batch's latest takeover (`Batch.takeover`). It changes no lane: the batch goes on where it was.

### What the driver that lost the batch does
- **It starts nothing more in the batch.** A driver's start of an attempt or of an action records `step.started` in the transaction that renews the batch's lease. When that renewal finds another driver's live lease, the start is not recorded and the batch is lost (`batch_lost`), as at a tick. A start or an effect that it decided under its lease, in its last transaction before the takeover, still goes ahead: the attempt's process starts, or the effect's call reaches its target, after the lease moved. That is the work the old driver had in flight, which the attempt lease and the wait for `until` below cover. With worktrees, the lease of the attempt it took first goes too, and its worktree is left for the cleanup ([ADR 0029](0029-attempt-worktrees-layout-claims-and-repair.md)).
- **An attempt still running under it ends under its attempt lease.** Its heartbeat renews that lease while the run goes on ([ADR 0051](0051-chaos-runs-on-the-real-driver-with-two-drivers-and-a-terminal.md)), and it records how the attempt ended at the step boundary, also in a batch it lost, and lets the lease go ([ADR 0044](0044-batch-leases-held-by-the-driver-and-one-command-log.md)). If it dies instead, the attempt lease expires and the new holder's supervisor loses the attempt ([ADR 0027](0027-supervisor-lost-and-stalled-attempts.md)). The takeover does not stop the run: the session that took over may want it to finish, and stopping a process tree is the old driver's own.
- **[ADR 0055](0055-a-step-waits-for-the-lease-of-its-abandoned-attempt.md)'s wait applies, to the same attempt too.** A driver starts no attempt while another driver holds a live lease of that same attempt (it is being started) or, as before, of another attempt of its step. The wait lasts one lease at most, and the attempt's deadline runs through it.
- **A takeover may land while a driver starts.** A driver that starts again drives on the batches its owner holds once its start has read them ([ADR 0044](0044-batch-leases-held-by-the-driver-and-one-command-log.md)), so a batch handed to or from it during its start is counted as the handover left it.

### What the new holder waits for
- **No driver applies an effect of a batch before its latest takeover's `until`.** The effect the old driver may still be applying was renewed for before it began, and ends within its deadline, which is below a lease ([ADR 0044](0044-batch-leases-held-by-the-driver-and-one-command-log.md)). So by `until` it has ended, and an effect is never applied twice. The batch's attempts start at once. Only its effects wait, at most one lease, and the batch is not let go while one is due.
- **The new holder keeps the batch's deadlines from its next tick.** A supervisor acts on its own and the free batches as of the start of its tick ([ADR 0044](0044-batch-leases-held-by-the-driver-and-one-command-log.md)). A batch handed over during a tick may have been skipped by both supervisors in it: a deadline or reminder that came due then is acted on at the new holder's next tick, a few seconds later.

## Consequences
- An engineer takes a batch from the Cellar, or from another session, at once: `foedrum brew <issue> --take`. The plugin (#336) runs that. The Cellar gets a batch back with `foedrum takeover <batch> --as cellar`.
- The handover is in the batch's history (`foedrum replay`), with who did it and from which driver.
- After a takeover, a push or a pull request of the batch may come up to one lease later than it would have (5 minutes by default).
- The chaos run with two drivers (`test/chaos/drivers.test.ts`) gets takeovers from the terminal between a driver's read and its append. Its checks already say that each attempt starts once, under its batch's lease, and that no two calls of one effect overlap. Four of them make room for what this record allows: a start or an effect counts as under its lease when the driver held it in its last transaction (the work in flight above); `nothingLeftWaiting` lets a scheduled attempt wait for a live lease of itself, and a taken-over batch's effects wait until `until`; the restart check counts no batch handed over during the start; and `nothingOverdue` leaves out a batch handed over in that move.
- Not covered: resuming a running batch's session in the engineer's Claude Code ([ADR 0019](0019-interactive-sessions-and-one-command-layer.md)'s "takeover" row of its session table), which is #338.

## Alternatives considered
- **Stop the old driver's running attempt at the takeover.** Rejected: the takeover runs in a terminal, not in the process that runs the attempt, and the attempt lease already keeps the step from running twice (I2).
- **Wait for the old lease to expire before taking the batch.** That is what happens without a takeover, and is the wait ADR 0019 asks a command to cut short.
- **Fence effects with a version in the lease.** The effect targets (GitHub) cannot check a fence, so it would only move the check into the driver, which the in-transaction read already does for starts. Effects would still need the wait.
- **Keep the old lease's end only in the store, not in the event.** Leases are local and never on the state branch ([ADR 0044](0044-batch-leases-held-by-the-driver-and-one-command-log.md)). A wait read from the event survives a rebuild of the store from the state branch, and the history says why the effects waited.
