# 0302. A stopped attempt's end is recorded, and its retry resumes its session and spends no attempt

Date: 2026-11-02 · Status: Accepted · Amends [0205](0205-stop-makes-an-order-s-brewing-batches-stuck-at-once-and-retry-continues-them.md) (the runner's end of a stopped attempt is recorded, the attempt counts toward no `maxAttempts`, and the retry resumes its session), [0117](0117-a-retry-resumes-the-session-of-the-attempt-before-it-in-that-attempt-s-worktree.md) (an attempt a stop abandoned, whose end came, resumes), [0025](0025-batch-lifecycle-stuck-reminders-and-rewind.md) (one abandoned attempt finishes), [0206](0206-a-run-out-usage-window-holds-every-brewer-attempt-until-it-reopens.md) (a stopped attempt, unlike a usage limit's, still waits for a person's `retry`, but counts toward no `maxAttempts`) and [0053](0053-recipe-files-reach-the-engine-brewer-steps-in-a-line-first.md) (an attempt a stop abandoned counts toward no `maxAttempts`)

## Context
`foedrum stop <order>` makes each brewing batch of the order Stuck at once with reason `stopped` and abandons its running attempt ([ADR 0205](0205-stop-makes-an-order-s-brewing-batches-stuck-at-once-and-retry-continues-them.md)).
The runner's end of that attempt was refused as the end of an abandoned attempt, so nothing recorded it, and two costs followed (#536):
- the session claude started was lost to the retry: `resumeOf` needs a finished attempt with claude's init report ([ADR 0117](0117-a-retry-resumes-the-session-of-the-attempt-before-it-in-that-attempt-s-worktree.md)), so `retry` started the step fresh and redid what the brewer had in its head;
- the stopped attempt counted against the step's `maxAttempts`, so a step with `maxAttempts` 2 went Stuck on `attempts_exhausted` after one real failure.

A pause's stop at `--by` already does both right ([ADR 0202](0202-pause-and-continue-hold-an-order-or-the-whole-brewery-at-its-next-convenient-point.md)): its cancelled end is recorded with `paused`, counts against nothing, and its retry resumes. A stop is a person's choice in the same way.

## Decision

### What a stop marks
- **The stop is as before**: each brewing batch goes Stuck at once with reason `stopped`, its unfinished attempts are abandoned, and the driver stops their runs at its next tick. The Stuck line and its options do not change.
- **The fold marks the attempts that Stuck abandons `stopped`** beside `abandoned`, for the count. An attempt an earlier Stuck abandoned keeps how it was abandoned, so a later stop of its batch does not mark it.
- **The Stuck lane of a stop names the attempts it abandoned** (`stopped` on the lane), for the end. A Stuck reminder, which makes the batch Stuck again for the same reason, keeps them; any other lane drops them.

### What is recorded
- **The runner's cancelled end of an attempt the stop abandoned is recorded**: a `step.finished` with the cancelled outcome, claude's init report, the receipt and the usage, and `stopped: true`. The attempt is finished and no longer abandoned.
- **Recording it never moves the batch**: it stays Stuck on the stop, no route runs and no attempt is scheduled.
- `decide`'s `finish` records an end as the stop's when it is cancelled, the attempt is its step's latest, and the lane of the Stuck batch names it: the stop that holds the batch abandoned it. The log says so, so no driver flag carries it, unlike `paused`: a pause can be lifted or replaced between the kill and the end, while a stopped batch stays Stuck on that stop until a person acts.
  A `skip`, a `rewind` or a `recipe` can leave the stopped attempt its step's latest while the batch brews again; its late end is then refused, also under a later stop, which did not abandon it.
- `admit` admits `stopped` on a `step.finished` only there (`stoppedEnd`), for every writer: on a batch that brews, on an attempt another Stuck or an earlier stop abandoned, on one a later attempt replaced, or on an end that is not cancelled, it is refused.
- Every other end of an abandoned attempt is refused as before: one another Stuck abandoned, and an end of a stopped attempt that is not cancelled (it finished as the kill came). That attempt stays abandoned.

### The count
- **No attempt a stop abandoned counts against `maxAttempts`**, whether its end was recorded or not: a person stopped it, it did not fail. `countedAttempts` (formerly `withoutPaused`) leaves it out beside those a pause stopped, those a usage limit ended, and those a Stuck abandoned before they started ([ADR 0222](0222-a-recipe-s-brewer-step-may-be-interactive.md)).
  So `retry` after a stop never spends one, and a later retryable failure still retries within `maxAttempts`.

### The resume
- **The retry resumes the stopped attempt's session** when its end was recorded: `resumeOf` finds that attempt finished with claude's report and not succeeded, so with `retryMode: resume` the retry continues the session in its worktree, or in its recreated checkouts for a Brewery order's read-only attempt ([ADR 0301](0301-a-brewery-order-s-read-only-attempt-reads-every-repository-in-a-checkout-of-each.md)). `resumeOf` itself does not change.
- **With `retryMode: fresh`** the retry starts fresh, as today.
- **A stopped attempt whose end never came** (its driver died, or a person retried before the end was recorded, whose late end is then not its step's latest any more) stays abandoned, and the retry starts fresh, as today: `<step>#<n> has no session claude started`.
- **An interactive step** ([ADR 0222](0222-a-recipe-s-brewer-step-may-be-interactive.md)) is as before: a stop does not end a person's session, whose later end is not cancelled and so is refused; a run stopped before its session opened ends cancelled and is recorded `stopped`, and its retry starts a fresh session, as every retry of an interactive step does.

## Consequences
- `stop` then `retry` continues the brewer's session where it was, and costs the step no attempt: the redo is only what the attempt had not committed or said before the kill.
- One abandoned attempt now finishes: code that reads an abandoned attempt as never ending reads it as finished once its end comes, which the driver's `isOver` already counts as over.
- `step.finished` gains one field, `stopped`, the fold's attempts one mark and the Stuck lane one list; no new event, lane or driver rule.
- The status comment and `foedrum stuck` show the stop as before; `foedrum brewers` counts the stopped attempt's cancelled end as it counts a pause's.

## Alternatives considered
- **The stop only flags the run, and the batch goes Stuck when the end arrives.** One rule for the end, as the pause's, but a stop would wait for the run to end, and a driver that died would leave the batch brewing with nothing to end it.
- **A driver flag on the finish, as `paused`.** The pause needs it, since its state can change between the kill and the end; a stop's batch stays Stuck, so the log already says it, and a flag the driver passes could be forged by any writer.
- **Count a stopped attempt whose end never came.** Simpler, since only a recorded end would be marked; but the person stopped it all the same, and the cost would fall on whether a driver lived through the stop.
- **Record every end of a stopped attempt, a failed or succeeded one too.** A success after the kill would hand the task tree on from a Stuck batch, and a failure would read as the brewer's; only the cancelled end is the stop's.
