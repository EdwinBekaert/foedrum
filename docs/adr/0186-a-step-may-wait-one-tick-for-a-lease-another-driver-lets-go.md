# 0186. A step may wait one tick for a lease another driver lets go

Date: 2026-10-25 · Status: Accepted · Amends [0051](0051-chaos-runs-on-the-real-driver-with-two-drivers-and-a-terminal.md) and [0055](0055-a-step-waits-for-the-lease-of-its-abandoned-attempt.md) (what the chaos check `nothingLeftWaiting` lets wait)

## Context
A scheduled attempt waits while its step has a live lease of an attempt the log shows finished or abandoned ([ADR 0055](0055-a-step-waits-for-the-lease-of-its-abandoned-attempt.md)).
A driver reads the leases once per pass of its drive.
When one driver holds both the batch and that lease, the end of the run lets the lease go inside its own drive loop, and the next pass starts the attempt.
After a takeover ([ADR 0124](0124-foedrum-takeover-hands-a-batch-to-another-driver-as-a-recorded-command.md)), they can be two drivers: the batch's new holder, and the old one, whose stopped run of the abandoned attempt still holds the lease.
In a tick where the holder drives first, it waits for the lease, and the other driver lets the lease go later in the same tick.
The holder starts the attempt at its next tick.
The two-driver chaos run found this on seed 1710582731 (#464): after that tick, `nothingLeftWaiting` saw a scheduled attempt with no live lease to excuse it, and failed although no batch stalled.

## Decision
- **The engine keeps the wait of one tick.** The attempt starts at the holder's next tick, and its deadline runs through the wait, as through any wait for a lease (`nothingOverdue` holds it to that deadline).
- **`nothingLeftWaiting` gets a fourth exception**, next to ADR 0055's: a scheduled attempt whose step had, as the tick began, a lease of an attempt the log shows finished or abandoned, held by a driver other than the batch's holder.
  The chaos engine records the attempt leases that are live as each tick begins (`leasedAtTick`).
- **The exception lasts one tick.** The check runs after each tick, and the next tick's record no longer has the lease, so an attempt still not started then fails it.
  A lease the batch's holder let go is never excused: that driver's own drive loop starts the attempt in the same pass.

## Consequences
- A batch handed over while a stopped run holds a lease may start the step's next attempt one tick late.
- The shrunk run of #464 is a fixed case in `test/chaos/drivers.test.ts`: the attempt waits in that tick, starts in the next, and the check still fails in that tick without the lease, with the holder's lease, or with the lease of an attempt that is not over.

## Alternatives considered
- **Wake the batch's holder when another driver lets a lease go:** drivers have no channel to each other besides the store, and the wake would win back one tick, which the step's deadline already covers.
- **Drive again after every driver's tick in the chaos harness:** it would hide the order the drivers really run in, and with it the case the check is about.
