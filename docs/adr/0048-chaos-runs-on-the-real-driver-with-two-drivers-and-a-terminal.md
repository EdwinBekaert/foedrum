# 0048. Chaos runs on the real driver, with two drivers and a terminal on one store

Date: 2026-10-16 · Status: Accepted · Amends [0033](0033-chaos-tests-effects-found-by-key-and-leases-at-start.md) (how the harness kills and restarts, and what it checks) and [0044](0044-batch-leases-held-by-the-driver-and-one-command-log.md) (which attempt leases the heartbeat renews)

## Context
The chaos harness ([ADR 0033](0033-chaos-tests-effects-found-by-key-and-leases-at-start.md)) killed and restarted the test driver (`test/helpers/brewing.ts`), one at a time, on one SQLite file. [ADR 0044](0044-batch-leases-held-by-the-driver-and-one-command-log.md) built the real driver (`openDriver`) and listed the chaos cases its rules need, for #107: two drivers competing for one batch, a driver killed while it holds a batch, a driver that loses its batch while an attempt runs, a terminal command between a driver's read and its append, and a driver restarted under its owner. None of them can happen with one test driver: they need several drivers on one store, and faults other than a kill.

## Decision

### The harness drives the real driver
- Every chaos run opens `openDriver` with the fake brewer runner, the fake code host as its effect target and `takes` every batch; the driver applies the effects due. The scenario's commands come from a terminal: a command log beside the drivers, which is never killed.
- Each driver process has a life. A kill ends it for good: whatever the dead driver still had in flight throws when it touches the store or the code host, also after its owner's next process started.
- Each owner has a fake lock that a kill frees, as the operating system frees the file lock of a process that died ([ADR 0037](0037-attempt-worktrees-in-the-engine-and-driver-locks.md)).
- A run has one SQLite connection to its file, which each process sees through its life (the kill points of ADR 0033). One thread runs every transaction to its end before the next begins, so a connection per process shows the same committed events; it only reloaded page caches, which tripled the CPU time. The run's command logs read the events through a cache that catches up after a transaction that appended; a read inside a transaction goes to SQLite, so an append a kill rolls back is never cached.

### Two drivers on one store
`test/chaos/drivers.test.ts` runs the generated scenarios with two drivers, `cellar` and `session`, both told to take every batch, for `FOEDRUM_RUNS` seeds like `restarts.test.ts`. They play every move at once, the first picked by the run's seed, and every call to the code host lets the other run for up to two turns of the event loop, so their passes interleave. Beyond the kills, from random streams of the run's seed:

- **Down after a kill:** half the time, a killed driver stays down for one to three moves, while its brewers may still run. Its batch and attempt leases expire, and the other driver must take the batch over.
- **Stalls:** a live driver stalls for one to three moves, as a paused process: it does nothing while its brewers run. It stalls with a chance of 20% per move while its runner runs an attempt, 2% otherwise: most attempts end at once, and a stall that catches none tests nothing.
- **Terminal commands mid-tick:** as a driver begins a transaction, after it read what it decides on, the terminal issues `retry` or `skip`, or now and then `cancel`, on a live batch, with a chance of 2%.

Checked after every move and at the end, besides ADR 0033's checks:

- each attempt is started at most once, by one driver;
- a driver starts an attempt or applies an effect only while the store shows its live lease of the batch;
- no two `applyEffect` calls for one key overlap;
- the log holds: the guard accepts every committed event after the events before it, so no writer decided on what it read before its transaction;
- a driver that starts again under its owner holds the batches its owner's live leases name.

ADR 0033's deadline check leaves out a batch whose live lease a driver that is down or stalled holds: no other driver acts on it until that lease expired. A move in which no driver ran is not one the drivers lived through. After a tick they lived through, no scheduled attempt waits unstarted and no effect due waits outside the ledger, except in such a batch or in one a terminal command changed in that move: the drivers see it at their next drive. A second test searches seeds from 1 until the runs reach every case: a contest for a batch, a takeover from a driver that is down and its lost attempt retried by the other, a batch lost while an attempt of it ran and that run stopped, a terminal command accepted mid-tick and a driver's command refused after one, and a restarted driver driving on its batches and retrying its lost attempt.

### The heartbeat renews no lease of an attempt that is over
The runs found a driver that stalled while plan#1 ran: the other driver took the batch, lost plan#1 and started plan#2, and the first, going on with a drive and an effect pass before its next tick, renewed plan#1's lease in the heartbeat before the effect. Two live leases of one step (I2) until its tick stopped the run. The heartbeat now renews the lease of an attempt its runner runs only while the log, read inside its transaction, shows that attempt neither finished nor abandoned: a read before it could miss a loss another driver had just appended. An attempt that still runs in a batch the driver lost keeps its lease, as ADR 0044 has it: that lease keeps the new holder from starting the step beside it.

## Consequences
- The cases of ADR 0044 run in every pull request (200 seeds) and nightly (1,000), on every leg. Each was checked against a defect planted in `src/` that it catches within 60 runs (#107's pull request lists them).
- At 200 seeds, measured beside `main` under the same load, `restarts.test.ts` takes 0.7 to 0.9 times its earlier CPU time and `drivers.test.ts` about as much as the earlier `restarts.test.ts`, which took 7.5 s on a quiet machine: both well under the 15 s ceiling of ADR 0036.
- Not covered yet, for a follow-up of #107: the worktree cases of ADR 0037 (a kill between making a worktree and recording it, between a batch's end and its cleanup or part-way through one, a batch cancelled while an attempt runs), a second process of a live driver, the state branch, shrinking a failing run, and the intake killed between `order` and `route`.
- The test driver stays for the property and unit tests that use it.

## Alternatives considered
- **A connection per driver process:** closer to separate processes, but three times the CPU time, and one thread shows nothing a shared connection hides.
- **The real driver lock in the harness:** a second process of a live driver would then test `lockDriver` too, but taking the lock (the work root's marker, the holder file, a fully synced commit) costs about 100 ms of CPU time per run. With the fake lock, such a probe tests only the fake: `openDriver` takes the lock before anything else and gets its owner from it. The unit and integration tests of `lockDriver` and `openDriver` cover the refusal.
- **An in-memory database:** no clear gain once the run has one connection, and the file keeps ADR 0033's "on an SQLite file".
- **Release the attempt lease when the batch is lost:** the new holder could then start the step beside a run that goes on (ADR 0044).
