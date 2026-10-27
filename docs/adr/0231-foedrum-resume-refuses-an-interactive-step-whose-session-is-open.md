# 0231. `foedrum resume` refuses an interactive step whose session is open

Date: 2026-10-27 · Status: Accepted · Amends [0222](0222-a-recipe-s-brewer-step-may-be-interactive.md) (the follow-up under "Leases and takeovers while it is open": resume of an open interactive attempt is refused at once, not taken over) and [0127](0127-foedrum-resume-takes-a-running-batch-over-and-continues-its-step-s-session.md) (an open interactive attempt is not a step resume takes a running batch over for)

## Context
[ADR 0222](0222-a-recipe-s-brewer-step-may-be-interactive.md) opens an interactive step's attempt as a `claude` session in a person's terminal, with no deadline while it is open, and records `interactiveSince` on its `step.started`.
`foedrum resume <batch> [<step>]` on a running batch takes the batch over for the step whose session runs ([ADR 0127](0127-foedrum-resume-takes-a-running-batch-over-and-continues-its-step-s-session.md)), and an open interactive attempt is such a step: it is started, with a session.
The takeover then moves the batch's lease, and resume drives the batch until the attempt that continues the session has ended.
But the open session cannot be stopped from outside (ADR 0222): a stop does not end it, so resume waits until the person closes it, and says nothing while it waits.
ADR 0222 left "refusing it at once, with a line that names the driver holding it" as a follow-up (#576).

## Decision

### What is refused
- **On an Ordered or Brewing batch, `foedrum resume <batch> [<step>]` refuses a step whose latest attempt is started with `interactiveSince`**, not abandoned: the step named, or, with no step named, the first such step of the batch.
  With no step named, an open session anywhere in the batch is refused, even when a headless step before it runs: a takeover would move the lease away from the driver that has the person's session.
- The refusal comes first, right after the target is chosen: before the session id is checked, before the Claude Code and terminal checks (in a terminal it would wait the same), and before the takeover, so nothing is taken over and no `batch.taken_over` is recorded.
  It exits 1 with one line.

### The line
- **With a live batch lease**: `foedrum resume: <step>#<n> of batch <id> is an interactive session open since <interactiveSince>, in <owner> until <lease expiry>: close it there, then foedrum resume <id> <step>#<n> opens it for reading`.
  The owner and the expiry are the batch's live lease's (`EventStore.batchLeases`), as `drivenBy` names them for brew.
- **With no live batch lease** (the foedrum that opened the session died): `foedrum resume: <step>#<n> of batch <id> is an interactive session open since <interactiveSince>, and no driver holds the batch: the supervisor loses the attempt once its lease lapses, and the batch waits for a session again`.
  It is still refused: the attempt is started until the supervisor loses it (ADR 0222), and a takeover would have nothing to stop.

### Unchanged
- **A finished interactive attempt** is opened for reading as [ADR 0126](0126-foedrum-resume-opens-a-finished-attempt-s-session-in-its-worktree.md) has it: a batch Stuck `waiting_for_session` is not running, so `<step>#<n>`, or the latest finished attempt, opens.
- **A scheduled interactive retry** stays refused as a fresh session, by `resumeOf` (ADR 0222: a retry of an interactive step starts a fresh session).
- **Every headless step** as before: a running one is taken over (ADR 0127).
- **`<step>#<n>` on a running batch** stays refused, naming the step alone (ADR 0127).

## Consequences
- With a session open in one terminal, `foedrum resume` in another says who has it and since when, at once, instead of waiting.
- The person who wants to read the session closes it first, and then opens the finished attempt with `foedrum resume <id> <step>#<n>`.
- A batch whose foedrum died with a session open is refused until the supervisor loses the attempt; then it is Stuck `waiting_for_session`, and `foedrum brew <issue> --take` in a terminal opens a new session.

## Alternatives considered
- **Take the batch over and wait, as today**: the session cannot be stopped from outside (ADR 0222), so the takeover only moves the lease while the person's session runs on, and the second command hangs without a line.
- **Take the batch over and return at once**: the batch would be held by a resume that drives nothing, and the brew with the person's session would lose it.
- **Wait with a line**: still a hang, for as long as the person keeps the session open, with no deadline (ADR 0222).
- **Refuse only the step named, and take over a headless step chosen with no step named**: the lease would move away from the driver that has the person's session all the same.
- **Take a batch with no live lease over**: nothing would stop the session's attempt, which stays started until the supervisor loses it, so resume would wait for that.
