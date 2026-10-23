# 0127. `foedrum resume` takes a running batch over and continues its step's session

Date: 2026-10-23 · Status: Accepted · Amends [0019](0019-interactive-sessions-and-one-command-layer.md) (how the "takeover" row of its session table works, and that the engineer's session is an attempt with an out doc), [0124](0124-foedrum-takeover-hands-a-batch-to-another-driver-as-a-recorded-command.md) (a takeover that names a step stops the old driver's run of it; `batch.taken_over` gains `resumes`), [0126](0126-foedrum-resume-opens-a-finished-attempt-s-session-in-its-worktree.md) (a running batch is no longer refused; resume is registered as a command that changes state), [0117](0117-a-retry-resumes-the-session-of-the-attempt-before-it-in-that-attempt-s-worktree.md) and [0118](0118-retrymode-resume-loads-and-an-answer-resumes-the-session-that-asked.md) (the driver of a resume continues every retry's and answer's session, whatever the brewer's `retryMode`), [0123](0123-foedrum-brew-drives-one-batch-under-an-owner-of-its-own.md) (a brew that loses its batch to a takeover that resumes a step records the runs it stopped before it refuses the batch), [0044](0044-batch-leases-held-by-the-driver-and-one-command-log.md) (resume on a running batch is a terminal command that drives the batch and holds its lease) and [0027](0027-supervisor-lost-and-stalled-attempts.md) (no stall limit judges the engineer's open session)

## Context
[ADR 0019](0019-interactive-sessions-and-one-command-layer.md) says of stepping into a brewer's session: "on a running batch, it takes over the batch … When the engineer is done, the session writes the out doc and the engine continues from the next step."
[ADR 0126](0126-foedrum-resume-opens-a-finished-attempt-s-session-in-its-worktree.md) built `foedrum resume` for a finished attempt and refused a running batch (#338).
[ADR 0124](0124-foedrum-takeover-hands-a-batch-to-another-driver-as-a-recorded-command.md) built the takeover: the batch's lease moves at once, the old driver starts nothing more, and an attempt still running under it ends under its attempt lease.
[ADR 0117](0117-a-retry-resumes-the-session-of-the-attempt-before-it-in-that-attempt-s-worktree.md) and [ADR 0118](0118-retrymode-resume-loads-and-an-answer-resumes-the-session-that-asked.md) built resumed attempts: a retry or an answered attempt continues the session of the attempt before it, in the worktree that attempt made, recorded with `session.resumes`, once that attempt finished with claude's init report and its lease is gone.

Three things were open:

- **The running process.** One session runs in one process at a time (ADR 0019). A takeover leaves the old driver's run going until it ends by itself, which may be a success, after which there is no step left to step into.
- **Who records the engineer's work.** The engineer's session must become an attempt with an outcome, so the engine goes on from it, and the history stays a list of attempts.
- **Which driver goes on.** A terminal command takes no batch lease (ADR 0044), and a `foedrum brew` that loses its batch stops driving it.

## Decision

### Which step
- **On an Ordered or Brewing batch, `foedrum resume <batch> [<step>]`** continues the session of a step: the one named, else the first step of the batch whose latest attempt runs a brewer's session (started, with a session, not abandoned) or waits to resume the session of the attempt before it (a scheduled retry or answered attempt that `resumeOf` resumes).
- It is **refused** for an Ordered batch ("no step of it has run yet"), for `<step>#<n>` ("name the step alone": the attempt that continues the session is the step's next one), and for a step with no such attempt, naming `resumeOf`'s reason when its waiting attempt would start fresh.
- The checks of ADR 0126 come first, against the session it continues: a session id that is no UUID, a Claude Code session (it prints `foedrum resume <batch> <step>`, without `#<n>`, to run in a terminal), stdin that is no terminal, and a transcript that is not on this machine. A refusal takes nothing over.

### The takeover names the step
- resume takes the batch over as ADR 0124's takeover, to the owner `resume-<pid>`, with the step it resumes: `batch.taken_over` gains **`resumes: <step>`**, and the fold keeps it on `Batch.takeover`. Without a live holder there is nothing to take over, and its driver holds the batch at its first tick.
- **The driver the batch was taken from stops its run of that step** at its next tick, as it stops a run that Stuck abandoned: only while it no longer holds the batch, only when the takeover's `from` is its owner and its `to` holds the batch now, and only that step's run. The fold keeps the latest takeover after resume has let the batch go, so a later loss of the batch without a takeover stops nothing. The run ends `cancelled` after claude's init, the driver records it at the step boundary (also in a batch it lost), and lets its lease go. The cancel schedules a retry when the step has an attempt left (`retry: true`); with none, the batch is Stuck as `attempts_exhausted`, and resume says so and resumes nothing.
- **`foedrum brew` records the end before it lets go.** A brew that loses its batch to such a takeover, to an owner that holds it, ticks on, within one lease, until the attempt leases it holds in that batch are gone, before it refuses the batch. A closed driver records no end, so the stopped run's lease would otherwise hold the step for a whole lease and the retry would start fresh (no init report).
- A takeover with no `resumes`, as `foedrum takeover` and `foedrum brew --take` make, stops nothing, as before.

### resume drives the batch until the resumed attempt ended
- resume runs the interactive driver of that batch alone on the wiring `serve` and `brew` share (`wireDriver`), under its own lock: `takes` that batch, `drivesOn` none, and **`resumes` every attempt of it**, whatever its brewer's `retryMode`: the engineer took it over to continue the session.
- resume renews the batch's lease at every pass from the takeover on, also while no attempt or effect of the batch makes its driver claim it, as while the old driver's run is being stopped.
- The retry waits for the stopped run's lease (ADR 0055), then starts as ADR 0117 starts a resumed attempt: under its own lease, in the recreated worktree of the attempt that made it, recorded as `step.started` with `session: { id, resumes, worktree }`.
- **Its runner opens the session in the foreground.** For a plan that resumes, the runner writes the settings file, removes the out doc a run before left (ADR 0118), prints one line naming the session, the worktree and the out doc to write, and runs `claude` with ADR 0126's interactive command line (`resumeArgs`) and the attempt's environment over the terminal's variables, merged by name as the platform reads it, as for a finished attempt. The engineer finishes the step, has the session write the out doc as the brewer's instructions say, and exits claude.
- **The out doc decides, as for every run.** The runner reads it and counts the commits on the attempt's branch as the headless runner does, and `settleAttempt` gives the ending: a missing or invalid out doc is a retryable failure, a `done` of a brewer that commits needs a commit, and claude's exit code counts. The attempt records no claude report: there is no stream with an init event.
- **A plan that starts fresh runs headless**, as its driver would: the session or its worktree could not be got back (ADR 0117's `fallback`), and resume never opens a session the brewer never had.
- While claude runs, the runner reports progress, so the heartbeat renews the attempt's lease and no stall limit judges a human. A stop (the step's deadline, a cancel) does not end the engineer's session: it is theirs, as in ADR 0126. The batch still goes Stuck at the deadline, and what the session writes after that is not read. The driver's lines wait until claude has given the terminal back, and Ctrl+C is claude's while it runs.
- **Its driver starts nothing more once the step's run is over** (the driver's `holds`): in the pass that records the resumed attempt's end, the next attempt, or a retry of the step, is due, and it is the batch's next driver's to start. A closed driver records no end of a run it still has, so starting one would cost an attempt and a lease.
- **The run may end by itself first**, succeeded or failed, before the stop reaches it: then no attempt will continue its session, and resume says so, resumes nothing and lets go.
- **Then resume lets the batch go**, at once rather than when its lease expires, and says how the attempt ended. The engine has already gone on from it (`decide` scheduled the next step, a retry, or made the batch Stuck). The Cellar takes the free batch at its next tick; a `foedrum brew` that left it takes it when run again. resume also lets go when the batch leaves Brewing first, when another driver takes it, or on a stop, and returns 0 only when the resumed attempt's end was recorded.

### The command
- resume's handler passes who ran it and from where, which the takeover records. The registry marks it as a command that changes state, since on a running batch it appends events; like brew, it opens the store through the wiring, not the command layer, and on a finished attempt it still appends nothing.

## Consequences
- An engineer steps into a running brewer's session from a terminal, `foedrum resume <batch>`, finishes the step there, and the batch goes on from the next step under its driver.
- Stepping in costs the step one attempt (the cancelled run); a step on its last attempt goes Stuck, and `foedrum retry` then `foedrum resume` continue its session.
- The engineer's attempt has no claude report, so a retry after it, by its driver, starts fresh.
- A driver that is gone when resume takes its batch over cannot stop its run: the run's lease expires within a lease, the supervisor loses the attempt, and its retry starts fresh (no init report), headless. resume waits for it and says how it ended.
- The plugin's `/foedrum:resume` prints the line for a running batch too.

## Alternatives considered
- **Wait for the old driver's run to end by itself.** It may succeed, and the engineer would wait up to the step's deadline for nothing to step into.
- **Stop the run at every takeover** (ADR 0124 rejected it): a person who takes a batch over to drive it may want the run to finish.
- **Record the engineer's session as the running attempt itself.** Its process belongs to the old driver, whose end would then race the engineer's; a new attempt naming the session it continues is what ADR 0019 asks.
- **Lose the old attempt from the terminal** (`lose`): a lost attempt has no init report and its process may still run, so its session could not be resumed (ADR 0117).
- **Keep driving after the resumed attempt**, as brew does. The engineer asked to continue one step; the batch's own driver goes on from there, and a terminal left open would hold the batch.
- **A fresh interactive session on a fallback.** It would look like the brewer's session but hold none of it, as ADR 0126 found.
