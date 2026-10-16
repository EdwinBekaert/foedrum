# 0044. Batch leases held by the driver, and one command log

Date: 2026-10-16 · Status: Accepted · Amends [0002](0002-event-sourced-engine-on-node-sqlite.md) (several writers on one store), [0011](0011-state-in-the-brewery-repository.md) (a batch lease outlives its driver's restart), [0019](0019-interactive-sessions-and-one-command-layer.md) (how one driver per batch is held), [0024](0024-state-branch-layout-outbox-and-divergence.md) (who flushes at a step boundary), [0025](0025-batch-lifecycle-stuck-reminders-and-rewind.md) (where a command is decided), [0027](0027-supervisor-lost-and-stalled-attempts.md) (which batches a supervisor acts on), [0028](0028-brewer-runner-outcomes-environment-and-test-first.md) (the driver renews leases, not the runner) and [0033](0033-chaos-tests-effects-found-by-key-and-leases-at-start.md) (who applies a batch's effects)

## Context
[ADR 0019](0019-interactive-sessions-and-one-command-layer.md) has one driver per batch at a time, "held as a lease with a heartbeat": the Cellar skips batches a session holds, and an expired lease frees the batch. It also puts every action behind one command layer that every surface uses. Until now there were only attempt leases, held by whoever started the attempt, and a test driver (`test/helpers/brewing.ts`) that drove every batch of its store. #37 builds the real driver and the command layer's commands that change state. Four questions were open.

- **Who renews a lease.** #11 (ADR 0028) left it to #37: the brewer runner, which sees the process, or the driver. A lease says "this driver still owns this batch". If the runner renewed it, an orphaned brewer process would keep the lease of a driver that is gone alive, and no other driver could take the batch over.
- **The conditions of ADR 0033 and ADR 0037.** A driver expires its own leases at its start, so it must first hold its lock (`startDriver` refuses otherwise). And two `applyEffect` calls for one key must never overlap: both would find nothing on the target and both would apply the effect. Within one driver its passes run one at a time; between two drivers nothing kept them apart.
- **Two writers on one store.** The supervisor, a driver and a terminal command (`foedrum retry`) each folded the events they had read, decided, and appended in a transaction of their own. Events another writer appended in between were not part of the decision. Two `retry`s of one batch from two terminals would both schedule the same attempt, a log the fold refuses.
- **Commands from untrusted input.** [ADR 0025](0025-batch-lifecycle-stuck-reminders-and-rewind.md) made commands TypeScript types and said that the surfaces that parse untrusted input into them give them zod schemas in `src/schemas/`.

## Decision

### One command log
- Every command is decided against every event committed so far, inside the write transaction that appends its events (`createCommandLog`, `src/engine/command-log.ts`). The transaction holds the store's write lock from its start (`BEGIN IMMEDIATE`), so nothing is appended between the decision and its events. Writes that belong with the events, such as an attempt's lease, go in the same transaction.
- The supervisor, the driver and the terminal's commands that change state all append through it. A command that another writer made moot is refused like any other, and the supervisor and the driver report it (`refused`).
- So one store has several writers, one at a time: [ADR 0002](0002-event-sourced-engine-on-node-sqlite.md)'s "single writer" is now the one transaction that holds the write lock, and readers still never block it.

### Who pushes the events
- [ADR 0024](0024-state-branch-layout-outbox-and-divergence.md) flushes the state branch at a step boundary. A driver's boundary flush is its supervisor's next tick, which flushes after its own events ([ADR 0027](0027-supervisor-lost-and-stalled-attempts.md)), at most one tick interval (5 s by default) after the boundary. The test driver did the same.
- A terminal command that changes state does not flush: the CLI has no state branch of its own. Its events wait in the store, which is the outbox ([ADR 0024](0024-state-branch-layout-outbox-and-divergence.md)), until a driver's next tick on that machine pushes them. A machine lost before that tick loses them, as it loses any event not yet pushed. Flushing from the CLI is a follow-up with the plugin, once the terminal opens the Brewery's state branch.

### Batch leases
- The store keeps one lease per batch (`batch_leases`, schema version 3, beside the attempt leases): `{ batchId, owner, expiresAt }`, where the owner is the driver's lock owner ([ADR 0037](0037-attempt-worktrees-in-the-engine-and-driver-locks.md)). It is alive while `expiresAt` is ahead.
- `holdBatch` (`src/engine/batch-leases.ts`) takes a free or expired lease, renews its owner's, and refuses another owner's live one, in the caller's transaction, so two drivers cannot both take a batch. `releaseBatch` lets only its owner's lease go.
- **The driver renews the lease, never the runner.** On every tick, and again before each effect it applies, it renews the lease of every batch it holds and the attempt leases of the attempts its runner still runs, so a long tick lets none of them expire. A run whose attempt the log shows finished while the runner still runs it was lost by another driver, and the driver stops it. A driver that dies stops renewing: its batch leases expire and free the batch, even while an orphaned brewer process runs on. The supervisor then loses that attempt once its attempt lease expires ([ADR 0027](0027-supervisor-lost-and-stalled-attempts.md)), and the driver that takes the batch retries it.
- A batch lease lasts `leaseMs` between renewals, 5 minutes by default, like an attempt lease.

### What a driver holds
- A driver takes a free batch only when it is told to (`takes`): the Cellar takes every one, an interactive session the batch it brews. It takes one when the batch has work for it: a scheduled attempt to start, or an effect due.
- It holds the batch until the batch has ended (on tap or cancelled), no attempt of it runs and no effect of it is due; then it lets the lease go. Until then it keeps it also while the batch is Stuck or Conditioning, so the session that brews a batch keeps it while its engineer answers.
- **Losing a batch stops the driver at the next step boundary** ([ADR 0019](0019-interactive-sessions-and-one-command-layer.md)). When its renewal finds another driver's live lease, the driver records how its running attempt ends and lets that attempt's lease go, but starts nothing more in the batch and applies none of its effects. The attempt lease keeps the new holder from starting the step beside it (I2).
- **A batch lease is not expired at a driver's start**, so on the same database it means something after a crash, unlike what [ADR 0011](0011-state-in-the-brewery-repository.md) said of leases; it is still local and never on the state branch. An attempt lease is, because its process died with the run that held it ([ADR 0033](0033-chaos-tests-effects-found-by-key-and-leases-at-start.md)). A batch lease names the driver, which is back: a driver that starts again under the same owner drives on the batches it held. It renews them on its first tick, or they expire.
- Only the batch lease is new mutable state, in the event store like the attempt leases; the engine rule's exceptions do not change.

### The driver
- `openDriver` (`src/engine/driver.ts`) takes the driver's lock (`lockDriver` in production), then runs `startDriver`, before anything else; when the start fails, it lets the lock go. Only then does it drive, one drive at a time, whether a tick or a direct call starts it.
- **Its supervisor acts on its own batches and the free ones** (`acts`, as of the start of each tick), never on a batch another driver holds: that driver's supervisor keeps its deadlines. Two supervisors may both act on a free batch; the command log refuses the second.
- **It applies a batch's effects only while it holds the batch's lease**, renewed before each effect, and its passes run one after another. So two `applyEffect` calls for one key never overlap, as long as one effect takes less than a lease: every effect target needs a deadline shorter than `leaseMs`. A failed effect is reported, and the batch's other effects wait for the next pass.
- The test driver (`test/helpers/brewing.ts`) stays as it is until the chaos harness moves onto the real driver (#107), so the chaos and property runs keep their kills and seeds in this change.

### The commands that change state
- The registry says of each command whether it changes state (`changesState`). Read-only commands (`doctor`, `status`, `stuck`, `replay`) open the store read-only and append nothing ([ADR 0030](0030-only-commands-that-change-state-are-recorded.md)). The others open the Brewery's store for writing, never create one, and append through the command log.
- `retry`, `skip`, `answer`, `recipe`, `rewind` and `cancel` each have a zod schema in `src/schemas/commands.ts` that parses the surface's input, and become the engine's human command with `by` (the user who runs it: the operating system's user name on the terminal, else `USER`, else `USERNAME`, else `unknown`, for a uid without an account in a container) and `via` (the surface). `decide` and the guard still check every event they produce.
- `answer <batch> <answers>...` takes one answer per question, in the order the batch asked them (`stuck` numbers them), so no file or JSON is needed. `rewind <batch> <step> <owner/name=sha>...` takes the commit of each repository it resets. `stuck` lists every Stuck batch with its reason, the options it offers and its questions.
- A human command takes no batch lease: the terminal is not a driver. The holder sees the new events at its next step boundary and drives on.

### Left for later
- **Takeover** as an explicit recorded command ([ADR 0019](0019-interactive-sessions-and-one-command-layer.md)), and the plugin commands with everything that starts `claude` (`brew`, `resume`), follow #17. A takeover will put the batch lease to the new driver and record the handover; the driver that held it already stops at the next step boundary.
- The parity test between surfaces comes with the plugin, the second surface it compares.
- An interactive session's owner, an id the session keeps when it is resumed ([ADR 0037](0037-attempt-worktrees-in-the-engine-and-driver-locks.md)), is chosen with the plugin that starts the session; `openDriver` takes whatever owner its lock has.
- The terminal has no `Recipes` yet: recipe files reach the engine's `Recipe` interface in a follow-up, and until then a command that schedules a step is refused with "the Brewery has no recipe <name>". `cancel` works.

## Consequences
- The Cellar and interactive sessions can run on one store: each drives its own batches, each supervisor keeps its own and the free batches' deadlines, and a terminal command beside them cannot corrupt the log.
- A batch whose driver died is free once its lease expires, at most `leaseMs` later, and the driver that takes it applies its effects; none is applied twice, since only the holder applies them and every effect is found by its key ([ADR 0033](0033-chaos-tests-effects-found-by-key-and-leases-at-start.md)).
- The store's schema version is 3; a store at version 2 is migrated when a writer opens it. A reader (`status`) refuses a store at another version, as before.
- Chaos cases that apply, for #107: two drivers competing for one batch (exactly one starts each attempt, no effect twice); a driver killed while it holds a batch, its brewer running on (the batch lease expires, the attempt is lost, the batch is taken and its effects applied once); a driver that loses its batch while an attempt runs (it records the end, starts nothing more); a terminal command between a driver's read and its append (refused or decided on the latest events); a driver restarted under its owner (drives on the batches it held). The harness also needs its driver to be `openDriver`.
- Every effect target the GitHub layer adds must time out within a lease.

## Alternatives considered
- **The runner renews the leases:** it knows the process is alive, but an orphan would keep a lease alive for a driver that is gone, and the batch could never be taken over.
- **Batch leases in the attempt leases table, under a key of their own:** no migration, but the supervisor and the worktree claims read that table as attempts, and a driver's start would expire its batch leases with its attempt leases.
- **Expire a driver's batch leases at its start, like its attempt leases:** one rule for both, but a session restarted under its id would lose its batches to the Cellar for a moment, and its batches did not die with it.
- **Let a human command take the batch lease:** the terminal would act as a driver for one command and hand the batch back; deciding against the latest events already keeps the log valid, and the holder drives on.
- **Decide outside the transaction and retry on conflict:** the store has no version to compare against; deciding inside the write transaction needs none.
- **One lease per Brewery instead of per batch:** simpler, but the Cellar and a session could not drive different batches at once, which ADR 0019 asks for.
