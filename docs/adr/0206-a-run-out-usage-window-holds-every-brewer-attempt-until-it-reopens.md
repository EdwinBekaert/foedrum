# 0206. A run-out usage window holds every brewer attempt until it reopens

Date: 2026-10-26 · Status: Accepted · Amends [0091](0091-a-run-out-usage-window-blocks-on-the-environment.md) (a usage limit no longer makes the batch Stuck), [0202](0202-pause-and-continue-hold-an-order-or-the-whole-brewery-at-its-next-convenient-point.md) (a hold of the engine's own beside a person's pause), [0027](0027-supervisor-lost-and-stalled-attempts.md) and [0055](0055-a-step-waits-for-the-lease-of-its-abandoned-attempt.md) (an attempt that has not started waits without its deadline while the window is closed, until its reopen) and [0053](0053-recipe-files-reach-the-engine-brewer-steps-in-a-line-first.md) (an attempt that met a usage limit counts toward no `maxAttempts`)

## Context
When a usage window of a Claude subscription runs out, claude refuses every request until the reset its message names (`You've hit your session limit · resets 3:45pm`).
[ADR 0091](0091-a-run-out-usage-window-blocks-on-the-environment.md) reads the four documented messages and makes the batch Stuck, blocked on the environment, so a person runs `foedrum retry` after the reset.
Meanwhile every other batch's brewer meets the same refusal, one Stuck batch at a time, and a person has to retry each one.
An engineer would wait for the reset and go on, and keep doing what needs no model meanwhile (#242).

The maintainer settled the details on #242 (2026-10-25): the reset is read in the machine's time zone as the next moment that matches, with a 5-minute margin, and an unreadable reset is tried again once an hour; the continue at the reset is the engine's own until the Innkeeper (#227) plans.
Holding only the family of an Opus or Sonnet limit is #537, not this decision.

## Decision

### The hold
- **An attempt that ends with a usage limit closes the usage window**: the driver records it on its `finish`, and the engine appends `usage.window_closed` `{ limit, resets, reopensAt, read }`: which limit, the reset as claude wrote it, the UTC instant the window reopens, and whether the reset could be read.
  It is an event of the engine's own, not a person's command: it names no person and no surface, and it names no batch, so it goes to the state branch's top-level log ([ADR 0024](0024-state-branch-layout-outbox-and-divergence.md)).
- **While the window is closed no brewer attempt starts, in any batch.**
  The driver's start loop skips a scheduled attempt that runs a brewer (`brews`, [ADR 0116](0116-the-driver-records-each-attempt-s-session-and-claude-s-report-goes-on-step-finished.md)); check steps, action steps (pull requests), effects (status comments, labels, claims), the intake, routing and cleanup go on, since none calls a model.
- **A running attempt is not stopped**: it meets the limit itself, or finishes when its request went through first.
- **An attempt that has not started has no deadline while the window is closed**, whatever its step: the supervisor does not expire it, and `expire` refuses it.
  A check step's attempt starts at once and never sits there; one that waits for a lease ([ADR 0055](0055-a-step-waits-for-the-lease-of-its-abandoned-attempt.md)) is bounded by the reopen too.

### The attempt that hit it
- **It spends no retry**: `step.finished` records it with `usageLimited: true` and its blocked outcome as before, and the step is scheduled again at once as a retry, as a pause's stopped end is ([ADR 0202](0202-pause-and-continue-hold-an-order-or-the-whole-brewery-at-its-next-convenient-point.md)), also on its step's last allowed attempt.
  The recipe counts the step's attempts without it, so the batch stays brewing, never Stuck on `attempts_exhausted`, and its next attempt waits for the reopen.
  A brewer that resumes ([ADR 0117](0117-a-retry-resumes-the-session-of-the-attempt-before-it-in-that-attempt-s-worktree.md)) continues the session the limit cut off.
- **Unlike `stop`** ([ADR 0205](0205-stop-makes-an-order-s-brewing-batches-stuck-at-once-and-retry-continues-them.md)), whose stopped attempt is abandoned, counts toward `maxAttempts` and waits for a person's `retry`: a usage limit is the subscription's wait, which ends by itself.
- `decide` refuses `usageLimited` on an end that is not blocked on the environment, as it refuses `paused` on one that is not cancelled.
- An end that `finish` refuses because its batch left brewing meanwhile (a `stop`, a deadline) closes nothing: the next brewer meets the limit and closes the window, at the cost of that one attempt.
- **A spend limit or a too-low credit balance** ([ADR 0129](0129-a-spend-limit-or-a-too-low-credit-balance-blocks-on-the-environment.md)) stays Stuck: nothing resets it by itself.

### The reset
- The driver reads claude's reset text in the machine's time zone as the next moment that matches, only in the documented forms ([ADR 0091](0091-a-run-out-usage-window-blocks-on-the-environment.md)): `3:45pm` (an hour 1 to 12, two digits of minutes, `am` or `pm`) is today at 15:45, or tomorrow once that has passed; `Mon 12:00am` (a weekday, `Mon` to `Sun`, before it) is the coming Monday at midnight, or the Monday after when that moment has passed.
  Across a change of clocks the wall-clock time is kept, as `pause --by` reads a local time.
- **A reset that matched within the last hour** is that reset, not tomorrow's or next week's: the driver may handle the end minutes after claude wrote it, and claude names the reset to the minute. The window then reopens after the margin, or at once when the margin has passed too, where a day or a week would hold every brewer for nothing.
- **A margin of 5 minutes** is added, so the first attempt after the reopen does not meet a window that claude's clock has not reopened yet.
- The event records the reopen as a UTC instant beside claude's text, so a reader on another machine sees both.
- **A reset the engine cannot read** (another form, or a machine whose zone ICU cannot use) reopens the window an hour after the limit, with `read: false`: the next brewer attempt then tries, and a refusal closes it for another hour.

### The reopen
- **When `reopensAt` has passed, the supervisor issues `reopen`**: the engine appends `usage.window_opened` `{ at }` and gives every scheduled attempt that has not started, in each brewing batch no person's pause holds, a new deadline from its step (`step.rescheduled`), as `continue` does.
  No person acts; until the Innkeeper (#227) plans, the reopen is the engine's own.
- **A paused batch** waits for both: its attempt starts only once the window is open and its pause is lifted, and `continue` gives it its deadline as before.
- **A later limit while the window is open** closes it again.
  **A limit while it is closed** (an attempt that was already running) records its step's end the same way, and moves the reopen only when its own is later: the window reopens at the latest reset claude named.
- **A stopped batch** ([ADR 0205](0205-stop-makes-an-order-s-brewing-batches-stuck-at-once-and-retry-continues-them.md)) and any other Stuck batch stays Stuck through a reopen: the reopen only gives deadlines to brewing batches.
- A driver killed while the window is closed folds the window from the event log at its restart, starts no brewer until the reopen, and the reopen comes from whichever supervisor ticks first after it.

### Every wait has a deadline
The closed window has one, its `reopensAt`, at which every attempt it held gets a fresh deadline: it is not ADR 0202's exception to invariant I5, which stays the only wait without a deadline.

### All limits hold every brewer
A session or weekly limit covers every model; an Opus or Sonnet limit covers only its family, and a brewer on another model would go through.
This decision holds every brewer attempt for all four, the safe side: a brewer that meets the limit costs one start, but a brewer that would have gone through waits until the reset.
Holding only that family's brewers, by the model each brewer runs, is #537.

### Where it shows
- **The status comment** of a brewing batch says, while the window is closed: `Usage window closed: claude hit its <limit> limit, which resets <resets>; brewers wait until <hh:mm> UTC, <day month>`, or for an unread reset `…; brewers try again at <hh:mm> UTC, <day month>`. A revision is due when it opens or closes, as for any text ([ADR 0072](0072-the-status-comment-edits-as-revisions-in-the-ledger.md)).
- **`foedrum status`** prints the same line above the board.
- **`foedrum replay`** lists the window's events beside the batch's own, as it lists a pause's; the attempt's `step.finished` shows it met the limit.

## Consequences
- A run-out window costs each running brewer one attempt that counts against nothing, and no person's retry: the Brewery goes on after the reset by itself.
- The other work of the Brewery goes on: a check, a pull request or a status comment never waits for the window.
- An Opus or Sonnet limit holds brewers on the other family too, until #537.
- The window is one fold field (`State.usageWindow`), two event types, one more `step.finished` flag, one engine command (`reopen`), a driver and a supervisor rule, and a reader of the reset; `openDriver` gains a `zone` option, the machine's by default, so `serve` and `brew` need no wiring of their own.
- Size: about 700 lines with the tests, in one pull request.
- Chaos case: a driver killed while the window is closed; after the restart no brewer starts until the reopen, and then the batch goes on to on tap.

## Alternatives considered
- **Keep it Stuck and retry it at the reset (a reminder that retries).** Each batch would still be Stuck on its own, and the other batches' brewers would meet the same refusal first.
- **A pause of the engine's own as an `order.paused --all` with a `by` of `foedrum`.** It would hold the intake, checks and pull requests too, and need a person's `continue` or a new kind of continue; the window holds only brewers, and reopens by itself.
- **Count the attempt that hit it, as a failure that may pass.** Its step's retries would go on a refusal that is no fault of the step, and its last allowed attempt would make the batch Stuck on `attempts_exhausted`.
- **Stop the brewers that still run when the window closes.** Each would meet the limit at its next request anyway; one whose request went through first may finish.
- **Read the reset in `decide`, with the zone in its context.** Every caller of `decide` would carry a zone that only this path needs; the driver reads it, as the CLI reads `pause --by`, and the event carries the instant.
- **Hold only the attempts of brewer steps from expiring.** Only the wiring knows which step is a check, so `decide` and the supervisor would need it too; a check's attempt starts at once, and the reopen bounds any other.
- **No margin, or a longer one.** Without one, an attempt at the minute claude named may still be refused; five minutes is the settled wait.
