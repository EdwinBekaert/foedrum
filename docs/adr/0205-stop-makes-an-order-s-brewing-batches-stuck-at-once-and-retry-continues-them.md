# 0205. `stop` makes an order's brewing batches Stuck at once, and `retry` continues them

Date: 2026-10-26 · Status: Accepted · Amends [0202](0202-pause-and-continue-hold-an-order-or-the-whole-brewery-at-its-next-convenient-point.md) (`stop` beside `pause` and `continue`), [0025](0025-batch-lifecycle-stuck-reminders-and-rewind.md) (a new Stuck reason, `stopped`) and [0030](0030-only-commands-that-change-state-are-recorded.md) (one more recorded command)

## Context
`pause` holds an order and lets what runs end at its next convenient point, or at `--by` ([ADR 0202](0202-pause-and-continue-hold-an-order-or-the-whole-brewery-at-its-next-convenient-point.md)).
Nothing ends an order's attempts now: an engineer who sees a brewer go the wrong way, or spend tokens on a step that will not help, can only `cancel` the batch, which ends it for good, or wait (#518, split from #241 on 2026-10-25).
A Stuck batch already does what a stop needs: Stuck abandons its unfinished attempts, whose processes the driver stops at its next tick ([ADR 0027](0027-supervisor-lost-and-stalled-attempts.md), with the Job Object of [ADR 0039](0039-windows-job-objects-through-a-powershell-helper.md) on Windows), and `retry` schedules the step again, resuming its session.

## Decision

### The command
- **`foedrum stop <order> [--why <reason>]`**, with a schema in `src/schemas/commands.ts`, changes state and is recorded with who issued it, from where and why ([ADR 0030](0030-only-commands-that-change-state-are-recorded.md)).
- `<order>` is written and checked as `pause` takes it: `<alias>#<n>` of a target repository, `#<n>` or `<n>` of the Brewery.
  A sub-order is refused with its order to stop instead, and so is the Brewery issue that is a claimed target issue's order, with the target issue.
- A stop of an order with no brewing batch is refused: nothing of it runs or is due.
- There is no `stop --all`: `pause --all --by <time>` already stops whatever runs at that time, holds the intake, and one `continue --all` lets it all go on, where a stop of everything would leave one `retry` per batch.

### What a stop does
- **Each brewing batch of the order goes Stuck** with reason `stopped`, its own issue's and its sub-orders' alike: `{ kind: 'stopped', stepId, by, via, why? }`.
  Who and why are on the reason, so a stop is a `batch.stuck` per batch and no event type of its own.
- **Its unfinished attempts are abandoned**, as by any Stuck ([ADR 0025](0025-batch-lifecycle-stuck-reminders-and-rewind.md)), so the driver that runs one stops its process tree at its next tick, as it stops any attempt Stuck abandoned.
  A batch whose attempt is scheduled but not started goes Stuck the same way, and that attempt never starts.
  The runner's end of a stopped attempt is refused as the end of an abandoned attempt, so it is not recorded and counts against no retry.
- **The step it names** is the step `retry` schedules again: the first step of the batch whose latest attempt had not finished; when a parallel group runs, one of its children, and `retry` resumes the group's other children that had not ended, as for any Stuck child ([ADR 0168](0168-a-parallel-group-runs-its-lens-steps-side-by-side.md)).
- **Ordered, Conditioning and Stuck batches are left as they are**: none runs an attempt. A Stuck batch keeps its reason (a question, a blocker), which a stop would hide.
  To hold an order and kill what runs, pause it, then stop it.
- **What the attempt committed stays** on its attempt branch, as for any abandoned attempt; a Stuck batch has not ended, so the cleanup keeps its worktrees, and a cancel after it keeps the task tree's branch ([ADR 0084](0084-a-batch-s-commits-end-in-a-pull-request-or-on-a-kept-branch.md)). What it had not committed is lost, as at `--by`.

### The options and the reminder
- A stopped batch offers what any Stuck batch without a question offers: `retry`, `skip`, `recipe`, `rewind`, `cancel`.
- `retry` schedules the named step again as a retry, so a brewer that resumes continues its session ([ADR 0117](0117-a-retry-resumes-the-session-of-the-attempt-before-it-in-that-attempt-s-worktree.md)).
- The Stuck reminder runs as for any Stuck batch: a stop is a decision to look again, and the reminder says it waits.

### A stop and a pause
- **A stop of a paused batch** makes it Stuck and leaves the pause as it is: a stop never lifts a pause.
  A `retry` of it schedules the step, and the attempt waits for `continue`, as any attempt of a paused batch does.
- **A pause of a stopped batch** is accepted, as for any batch that has not ended: it holds what the batch schedules after its `retry`.

### Where it shows
- The status comment's Stuck line says the step was stopped, by whom, from where and why.
- `foedrum status`, `foedrum stuck` and `foedrum replay` show `stopped at <step> by <who> via <surface>: <why>`.

## Consequences
- An engineer can end an order's work at once and go on later from the same step, without spending an attempt or the batch.
- One more Stuck reason in every `switch` over reasons; no new event type, lane or driver rule.
- The kill costs the work since the attempt's last commit; `pause --by` is the gentler way when the work can wait for its next convenient point.
- Chaos cases: a stop during an attempt, a stop and a retry, and a driver killed during a stop; after the restart nothing of the stopped batch runs until `retry`.

## Alternatives considered
- **A `batch.stopped` event beside `batch.stuck`.** Records the command apart from its effect, but two events per batch where the reason can carry who and why, and every reader of Stuck would have to look at both.
- **Stop every batch of the order, Ordered and Conditioning included.** Nothing of those runs, so there is nothing to kill; an Ordered batch has no step for `retry` to schedule, and a Conditioning one waits on a merge or a release a stop cannot hurry.
- **`stop --all`.** See above: `pause --all --by` already does it, and is lifted in one command.
- **A positional reason (`foedrum stop '#12' lunch`), as #518 sketched.** `pause` takes `--why`; the two read alike.
- **Only `retry`, `rewind`, `recipe` and `cancel`, without `skip`.** A stopped step may be one the engineer decided not to finish, and `skip` is the command for that; leaving it out would make a stop the one Stuck reason without a question that cannot skip.
- **Kill through the pause's stopAt (`paused` on the end).** Would keep the batch brewing and spend no Stuck, but a stop is meant to wait for a person, which a pause does only until `continue` and without a reminder.
