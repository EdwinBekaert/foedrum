# 0202. `pause` and `continue` hold an order, or the whole Brewery, at its next convenient point

Date: 2026-10-26 · Status: Accepted · Amends [0019](0019-interactive-sessions-and-one-command-layer.md) (`pause` given its meaning, and `continue` added), [0025](0025-batch-lifecycle-stuck-reminders-and-rewind.md) (a paused batch's attempt that has not started waits without its deadline), [0027](0027-supervisor-lost-and-stalled-attempts.md) (the supervisor expires no such attempt: an exception to I5), [0055](0055-a-step-waits-for-the-lease-of-its-abandoned-attempt.md) (a waiting attempt's deadline does not run while a person's pause holds it), [0053](0053-recipe-files-reach-the-engine-brewer-steps-in-a-line-first.md) (an attempt a pause stopped counts toward no `maxAttempts`), [0030](0030-only-commands-that-change-state-are-recorded.md) (two more recorded commands), [0044](0044-batch-leases-held-by-the-driver-and-one-command-log.md) (a driver starts nothing paused), [0123](0123-foedrum-brew-drives-one-batch-under-an-owner-of-its-own.md) (`brew` refuses a paused order), [0068](0068-the-intake-in-foedrum-serve-brewery-orders-and-routing-by-label.md) (`pause --all` holds the intake) and [0168](0168-a-parallel-group-runs-its-lens-steps-side-by-side.md) (a group under a pause)

## Context
An engineer needs to halt work: one order now, or everything at the end of the day, and go on later (#241).
`pause` is in the command list without a meaning, and `resume` already means stepping into a brewer's session ([ADR 0126](0126-foedrum-resume-opens-a-finished-attempt-s-session-in-its-worktree.md)), so going on gets its own word, `continue`.
`cancel` ends a batch for good, and a Stuck batch waits for a decision: neither holds a batch that is fine and should simply not go on now.
Killing what runs at once is `stop` (#518), not this.

The maintainer settled the open details on #241 (2026-10-25): `pause --all` holds the intake too, `--by` takes a local time or a duration, a parallel group's children each end at their own point, and only a person continues until the Innkeeper (#227).
Messaging a running brewer to finish early is left to an issue of its own: the engine cannot reach a session's inbox on Windows, and a "stopped by a pause" out doc does not exist yet.

## Decision

### The commands
- **`foedrum pause [<order> | --all] [--by <time>] [--why <reason>]`** and **`foedrum continue [<order> | --all]`**, each with a schema in `src/schemas/commands.ts`, change state and are recorded with who issued them and from where ([ADR 0030](0030-only-commands-that-change-state-are-recorded.md)), and with the reason when one is given.
- `<order>` is written as `order` takes an issue: `<alias>#<n>` of a target repository, `#<n>` or `<n>` of the Brewery; exactly one of `<order>` and `--all` is given.
- A pause of an order holds every batch of its issue, and a sub-order's batch with its order's; `--all` holds every batch of the Brewery, those ordered later included.
- A pause is refused for an order with no batch that has not ended; a second pause of the same order, or a second `--all`, replaces the first, so `--by` can be added or moved.
  Under `--all` an order's own `--by` still holds when it comes first: a batch is stopped at the earlier of the two.
- `continue <order>` lifts that order's pause, and is refused when the order is not paused or while `--all` holds the Brewery (`continue --all` lifts it); `continue --all` lifts `--all` and every order's pause.

### What a pause holds
- **No new attempt starts.** A driver starts no scheduled attempt of a paused batch: no brewer, check or action step, so no pull request is opened after the pause either.
- **A running attempt ends at its next convenient point**: its out doc, a question (`needs_input`), a pull request opened, a review delivered.
  Its end is recorded as any end is, and what it schedules next waits.
  Effects go on (status comments, labels, claims), since they record what already happened; so do the supervisor's deadlines of running attempts, stalls and reminders.
- **A parallel group** ([ADR 0168](0168-a-parallel-group-runs-its-lens-steps-side-by-side.md)): each running child ends at its own point; a child scheduled but not started waits, and the group waits for it.
- **A scheduled attempt that has not started has no deadline while its batch is paused**: the supervisor does not expire it, since the wait is a person's, not the step's.
  This is the one exception to "every wait has a deadline" and to invariant I5, and to what [ADR 0055](0055-a-step-waits-for-the-lease-of-its-abandoned-attempt.md) rejected: a pause is a wait the person chose, shown in the status comment with who, why and `--by`, and only a person continues it until the Innkeeper (#227). It has no reminder.
  `continue` gives each such attempt of the batches it lifts a new deadline from its step (`step.rescheduled`), as if it had just been scheduled, so a long pause never makes a batch Stuck on its deadline.
- **At `--by`, what still runs of a paused batch is stopped** by the driver that runs it, at its next tick.
  Its end is the runner's for a stopped run (cancelled), recorded with `paused` on its `step.finished`: the pause is the person's choice, not a failure, so that attempt counts against none of the step's retries.
  The step is scheduled again at once, as a retry, so a brewer that resumes continues its session, whatever attempts it has left; that attempt waits for `continue`, and the batch stays paused, never Stuck on `attempts_exhausted`.
  The driver's flag decides, not the pause's state when the end is recorded: an end that comes after the pause was lifted or replaced is the pause's too, and its retry starts at once when nothing holds the batch any more; `decide` refuses `paused` on an end that is not cancelled.
- **`pause --all` holds the intake**: no Brewery issue is ordered and no target issue claimed until `continue --all`; the engine's `order` command is refused while it holds.
  The intake still records pull request ends, checks bases and routes Ordered batches, which starts nothing, so an Ordered batch does not go Stuck on routing because of a pause.
  A pause of one order leaves the intake alone, and `foedrum order`, a person's own decision, is not held.
- **`serve` and `brew` start nothing paused**, also after a restart: the pause is in the event log, which every driver folds.
  `brew` of a paused order is refused with a line that says to continue it first, rather than waiting with nothing to do.

### `--by`
- `--by` takes a local time, `HH:MM` (`17:30`: today in the machine's time zone, tomorrow if that is already past), or a `Duration` (`20m`, `2h`) from now.
- The event records the UTC instant (`stopAt`) and the IANA zone of the machine that gave it (`zone`); the status comment shows the instant in UTC with the time in that zone beside it, so a reader elsewhere sees both.

### Events
- `order.paused` `{ order?, by, via, why?, stopAt?, zone? }` and `order.continued` `{ order?, by, via }`: `order` absent means `--all`. They name no batch, so they go to the state branch's top-level log ([ADR 0024](0024-state-branch-layout-outbox-and-divergence.md)).
- `step.rescheduled` `{ batchId, stepId, attempt, deadlineAt }`: the new deadline of a scheduled attempt that has not started, while its batch is brewing.
- The fold keeps the pauses in `State.pauses` (`all`, and each order's by its issue and repository); `pauseOf(state, batch)` says whether, and by what, a batch is held.

### Where it shows
- The status comment of a paused batch that has not ended says **Paused**, with who, from where, why and the `--by` instant; a revision is due when it changes, as for any text ([ADR 0072](0072-the-status-comment-edits-as-revisions-in-the-ledger.md)).
- `foedrum status` adds `paused` to the batch's detail, and `foedrum replay` lists the pause and continue events that held the batch beside its own, and the pause in its state.

### Who continues
Only a person, until the Innkeeper's planning job (#227) decides when to continue and asks when in doubt; marking a pause "only I continue" waits for it.

## Consequences
- An engineer can stop a Brewery at the end of the day without losing an attempt underway, and stop one order without touching the rest.
- A kill at `--by` costs the work the attempt had done since its last commit, but no attempt of the step: a recipe's `maxAttempts` counts every attempt but those a pause stopped.
- A pause has no reminder: the person who paused it decided to wait, and the status comment shows it. A batch that is Stuck or Conditioning keeps its reminders.
- Three event types, a fold field and a driver, supervisor and intake rule; `serve` and its wiring are unchanged.
- Chaos case: a driver killed during a pause; after the restart nothing starts until `continue`, and then the batch goes on to on tap.

## Alternatives considered
- **A lane of its own (Paused).** One more lane in every `switch`, the guard's table and the board, and a running attempt would have to finish in a lane that is not brewing; a pause also covers batches ordered later, which a lane cannot.
- **Decide nothing new while paused (no `step.scheduled` until `continue`).** Keeps deadlines as they are, but `continue` would have to work out what each finish would have scheduled, repeating the state machine.
- **Keep the deadline of a waiting attempt through the pause.** A pause longer than a step's deadline would make the batch Stuck on its deadline, which a person did not cause.
- **Count the kill at `--by` as an attempt, as a lost one is.** No new field, but a kill of a step's last allowed attempt would make the batch Stuck on `attempts_exhausted` for what a person chose.
- **Hold the whole intake, routing included.** An Ordered batch would go Stuck on routing an hour into a pause.
