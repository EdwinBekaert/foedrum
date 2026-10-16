# 0037. Attempt worktrees in the engine, the Brewery marker and driver locks

Date: 2026-10-16 · Status: Accepted · Amends [0029](0029-attempt-worktrees-layout-claims-and-repair.md) (how two Breweries on one work root are refused) and [0033](0033-chaos-tests-effects-found-by-key-and-leases-at-start.md) (the lock a driver holds before it expires its own leases)

## Context
[ADR 0029](0029-attempt-worktrees-layout-claims-and-repair.md) built the attempt worktree manager and left three follow-ups for #56: record each worktree in the attempt's events, run the cleanup at engine start and when a batch ends, and refuse two Breweries on one work root, since each would take the other's batches for unknown ones and remove their clean worktrees. [ADR 0033](0033-chaos-tests-effects-found-by-key-and-leases-at-start.md) added a condition for the real drivers (#37): a driver that starts expires the leases its own owner holds, so it must first make sure that no other process runs as that owner. Otherwise it would expire the live leases of that process.

One exclusive lock per work root would cover both conditions, but it would also allow only one driver per Brewery on a machine. [ADR 0019](0019-interactive-sessions-and-one-command-layer.md) has two kinds of driver on one event store at the same time: the Cellar and the engineers' interactive sessions ("the Cellar skips batches leased by a session"). They share the Brewery's work root.

## Decision

### The work root's Brewery marker
- `<workRoot>/brewery.json` records the Brewery the work root belongs to (`{ "brewery": "owner/name" }`). It is a marker, not a lock: it stays after every driver has exited, so nothing has to decide when the last driver lets go of it.
- The first driver on a new work root writes it. The file is written whole next to its place and linked in (`link`, which fails when the name exists), so it appears complete and only once, whoever comes first. Every driver then reads it. When the recorded Brewery is another one, the driver is refused (`OtherBreweryError`), now and after the other Brewery's drivers have stopped. Names are compared without case, as GitHub compares them.
- A marker that cannot be read refuses every driver and stays as it is. Only a human who knows that no other Brewery uses the work root removes it.
- This replaces ADR 0029's idea of refusing a work root whose batch folders a newly initialised store does not know. A store rebuilt from the state branch belongs to the same Brewery and may meet its own debris, and the marker tells the two cases apart without guessing.

### A lock per driver
- Every driver holds `<workRoot>/drivers/<owner>.lock` for as long as it runs (`lockDriver`, `src/engine/driver-lock.ts`). A second process with the same owner is refused (`DriverRunningError`). Drivers with other owners of the same Brewery run beside it.
- The lock is a SQLite database in exclusive locking mode. Its first write takes an exclusive file lock (`fcntl` on macOS and Linux, `LockFileEx` on Windows), and SQLite keeps it until the connection closes. The operating system drops that lock when the process dies, however it dies. So a crashed driver leaves no stale lock to detect: the next process simply takes it, with no manual cleanup. The identity of the holder is the live process itself, not a pid, so pid reuse cannot make a dead driver's lock look alive, nor a live one's look dead.
- The holder's pid and start time are written next to the lock (`<owner>.holder.json`) once it is taken. They only go into the message a refused driver shows. Nothing is decided by them.
- A driver expires its leases through `startDriver`, which takes the owner from the lock and refuses unless the lock is held, so a driver expires leases only under its own lock. `expireOwnLeases` itself stays as ADR 0033 made it.
- **A driver's owner is stable across its own restarts**, otherwise `expireOwnLeases` never finds the leases of its earlier run. The Cellar is always `cellar`. An interactive session needs an id that the same session keeps when it is resumed (#37 chooses it, for example from the session it resumes). The owner is one path segment (`PathSafeId`).
- The lock is per machine: two machines with work roots of their own do not see each other's locks. Two drivers with the same owner on two machines share only the event store, and the state branch's divergence rules handle that ([ADR 0024](0024-state-branch-layout-outbox-and-divergence.md)). SQLite's locks are not reliable on network file systems, so a work root belongs on a local disk.

### A driver's start
`startDriver` (`src/engine/driver-start.ts`) does, in this order, before the driver takes new work:
1. it checks that the driver lock is held, which `lockDriver` took after checking the marker;
2. it expires the leases of its own earlier run (ADR 0033);
3. it repairs the attempt worktrees of every repository over every batch, with the claims of the state and the leases that are left.

The leases go first because the attempts of the earlier run died with it: they claim no worktree, and a crash's leftovers in an ended batch can go at once.

### Recording an attempt's worktree
- `step.started` carries `worktree: { repo, path, branch, commit }`, the worktree the attempt was given, at the commit it was made at; the fold keeps it on the attempt. A resumed session's attempt runs in the worktree of the attempt it continues (ADR 0029), names it in `session.worktree`, and has no `worktree` of its own.
- A driver first takes the attempt's lease, then makes its worktree (`create`), then records `step.started` with the worktree. A crash between making and recording leaves the attempt scheduled. The next start of that attempt reuses the untouched worktree (ADR 0029).
- When `create` refuses (something of the attempt is in the way), the attempt is recorded as started without a worktree and fails retryably with `the attempt could not get its worktree: <reason>`. The next attempt has names of its own, and nothing in the way is touched.
- The commit is the base, not the attempt's last commit. That is enough while the batch is live, since a cleanup never deletes the branches of a live batch and `recreate` uses the branch first. Recording the last commit when an attempt finishes goes with the runner (#11).

### Cleaning up when a batch ends
- A driver cleans a batch's worktrees (`createWorktreeCleanup(...).batchEnded`, `src/engine/worktree-cleanup.ts`) after a command whose events put it on tap or cancel it, and again when an attempt of an ended batch lets its lease go. A batch cancelled while an attempt runs keeps that worktree under its lease at first. The driver stops the attempts of an ended batch, so the second cleanup follows soon after.
- A cleanup goes over every repository the Brewery's attempts write in. A repository whose facts cannot be gathered is reported (`could not clean <root>: …`) and the others go on. A failed cleanup never stops a driver: what it leaves is kept, not lost, and the next cleanup or start tries again.
- Every clean takes the claims of the moment: the folded state and the leases alive now (`worktreeClaims`).

### Where it lives
The test driver (`test/helpers/brewing.ts`) does all of this, with a fake manager in unit tests and the real one in `test/integration/attempt-worktrees.test.ts`. The real drivers (#37, the Cellar) call `lockDriver`, `startDriver` and `createWorktreeCleanup` in the same way.

## Consequences
- The Cellar and any number of interactive sessions of one Brewery run side by side on one work root. A second Cellar, a session started twice with one id, or a driver of another Brewery is refused with a message that says who holds the work root.
- A crashed driver's lock is free at once. Its leases expire at its next start, and its worktrees are repaired then.
- Chaos cases that apply, for #107: a kill between making a worktree and recording it (the next start reuses it); a kill between a batch's end and its cleanup, and part-way through a cleanup (the start's repair finishes it); a driver killed while it holds its lock (its next process takes the lock and loses the attempts); a second process of a live driver (refused, with no lease expired); a batch cancelled while an attempt runs (its worktree goes once that attempt's lease does). The harness needs a lock that a kill releases, as the operating system does.
- `step.started` has a new optional field, and the JSON Schema changes with it. Earlier events stay valid.

## Alternatives considered
- **One exclusive lock per work root:** one mechanism for both conditions, but only one driver per machine. The Cellar and an interactive session could not run at once, which ADR 0019 asks for.
- **A lock file with a pid and a start time, taken over when that process is gone:** it works where file locks do not (network file systems), but staleness is decided by comparing identities. Reading a process's start time differs on each platform, and two processes that find the same stale lock must race safely to take it over. The OS-held lock has no stale state at all.
- **Refuse a work root whose batch folders the store does not know (ADR 0029):** no marker to keep, but it guesses. A store rebuilt from the state branch without its last events would be refused in its own work root, and another Brewery's empty work root would pass.
- **Per-owner locks in the event store:** the store is per Brewery checkout, so two checkouts of different Breweries on one work root would still not see each other.
