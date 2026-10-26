# The engine

The engine is plain, deterministic code: every change is a command decided against the folded state and appended as events, and state is a pure fold over those events.

| Page | What it covers |
|---|---|
| [Events](events.md) | The event log, how a change is decided, the event types |
| [Leases](leases.md) | Attempt leases and batch leases |
| [The event store](event-store.md) | The SQLite store, the idempotency ledger, deadlines |
| [The fold and the guard](fold.md) | State from events, and what the guard refuses |
| [Step outcome](step-outcome.md) | The single contract every step ends in |
| [Batch lifecycle](lifecycle.md) | Lanes, the state machine, the supervisor |
| [Invariants](invariants.md) | I1–I6 |
| [Failure modes designed out](failure-modes.md) | How each class of stuck orchestrator is removed |
| [The state branch](state-branch.md) | Durable state in the Brewery repository |
| [Worktrees](worktrees.md) | Attempt worktrees, the task tree, the cleanup |
| [Drivers](drivers.md) | The Cellar, driver locks, batch ownership, takeover |
| [The usage window](usage-window.md) | Brewers held while claude's usage window is closed, and its reopen |
