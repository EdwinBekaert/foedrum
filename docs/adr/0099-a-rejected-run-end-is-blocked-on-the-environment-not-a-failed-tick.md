# 0099. A rejected run end is blocked on the environment, not a failed tick

Date: 2026-10-20 · Status: Accepted · Amends [0028](0028-brewer-runner-outcomes-environment-and-test-first.md)

## Context
[ADR 0028](0028-brewer-runner-outcomes-environment-and-test-first.md) makes every attempt end through `settleAttempt`, from the facts the runner gathered, and says what happens when the runner dies with its process: nothing is recorded, nobody renews the lease, and the supervisor loses and retries the attempt ([ADR 0027](0027-supervisor-lost-and-stalled-attempts.md)). It does not say what happens when the runner stays alive but its `ended` promise rejects: the stream reader, the out doc read or the commit count threw instead of turning what it saw into facts.

Until #130 the driver threw that rejection from `drive()`. The tick failed, and the run stayed in the driver's `runs`, so the heartbeat kept renewing its lease for as long as the runner still reported the attempt. Nothing ever recorded the attempt. The other runs that ended in the same pass waited for a later drive, which would throw again while the entry stayed.

## Decision
- **A run whose end rejects is recorded like any other ended attempt**, at the next step boundary, as `blocked` + `environment`: the batch is Stuck at once, and a human's `retry` starts the step again. The driver decides this itself, because a runner that broke left no facts for `settleAttempt` to read.
- **Its summary** is the first line of the error's message (the text of anything thrown that is no `Error`), trimmed and cut to 120 characters, as a garbage line is quoted in ADR 0028: the runner may quote what it read, which is untrusted and may be long. When that leaves nothing, the summary is `the brewer runner failed without a message`, since the event store refuses an empty one.
- **Its process is stopped** (`run.stop()`, which does nothing once the attempt ended) before its lease is let go: a runner that rejects while the process still runs must not leave it writing beside a retry (I2).
- **Its lease goes** with the finish, and also when the finish is refused, as for any ended run. Its `runs` entry goes too, so the heartbeat renews nothing of it.
- **The driver reports it** with a `run_failed` notice that names the attempt and carries the whole error, which `foedrum serve` prints in one line. The tick goes on with the other runs, and `drive()` resolves.

## Consequences
- A broken runner can no longer stop a driver's ticks, or keep a lease alive with nothing recorded.
- The event log holds at most 120 characters of the error; the full error stays local, in the notice.
- A runner bug makes its batch Stuck instead of retried. A human sees it, with the summary and the notice, and decides; a bug that would fail every retry the same way does not use up the step's attempts.
- `settleAttempt` keeps its table: a rejection is no fact of a process, so it adds no row there.

## Alternatives considered
- **Lose and retry it through the supervisor**, as for a runner that died: drop the run and stop renewing its lease, so it expires and the attempt is retried. A broken runner usually breaks again the same way, so each retry spends an attempt and a lease's wait before the batch is Stuck anyway, as `attempts_exhausted`, which names nothing of the cause.
- **A retryable failure**: the same spent attempts, without the wait.
- **Keep throwing from `drive()`**: the failed tick is printed, but nothing is recorded and the lease is renewed forever (#130).
- **The whole message as the summary**: no limit on what an untrusted stream can put into the event log and the state branch.
