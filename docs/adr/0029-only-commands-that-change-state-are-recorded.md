# 0029. Only commands that change state are recorded

Date: 2026-10-15 · Status: Accepted · Amends [0019](0019-interactive-sessions-and-one-command-layer.md)

## Context
[ADR 0019](0019-interactive-sessions-and-one-command-layer.md) puts every action behind one typed command and says: "Every command is recorded as an event with **who** issued it and **from where**." The first commands in the registry (#13) are `doctor`, `status` and `replay`, and none of them changes anything: they read the machine or the event store and print.

Recording them would have consequences the rule did not weigh:

- **The log grows with reads.** A `watch foedrum status`, a dashboard that polls, or a plugin that checks the CLI version before every command would append an event each time. Every event is validated on append, folded, and pushed to the state branch with the next step boundary ([ADR 0024](0024-state-branch-layout-outbox-and-divergence.md)), so reads would cost commits on the Brewery's history and replay time forever.
- **Reading would have to write.** `foedrum doctor` must work before there is a Brewery, and `foedrum replay` is how a human inspects a store that may be corrupt or diverged. Neither should have to append to it first.
- **Reads would race the engine.** A status from the terminal while the Cellar runs would be a second writer to the store and the state branch for no state change; ADR 0011 designs out two writers.
- **Nothing would replay it.** The fold has nothing to do with a read: a `status.requested` event changes no batch, lane or ledger entry.

What the rule protects is still needed: when a human answers, retries, rewinds or cancels, the log must say who did it and from where. The events that do that already carry `by` and `via` (`batch.recipe_chosen` by a human, `input.received`, `batch.resumed`, `batch.rewound`, `batch.cancelled`).

## Decision
- **A command that changes state is recorded:** the events it appends carry who issued it (`by`) and from where (`via`, the surface). That is how it is recorded; there is no separate "command received" event.
- **A read-only command appends nothing.** `doctor`, `status`, `replay` and `stuck` read the machine or the event store and print. They never take a lease, append an event or push the state branch.
- A command is read-only or changes state by its definition, not by its input: a command that may append on some inputs counts as one that changes state.
- Authorisation ([ADR 0019](0019-interactive-sessions-and-one-command-layer.md)) still applies to read-only commands where it matters, for example a `/foedrum status` comment from a user who is not allow-listed; it is just not logged as an event.
- Everything else in ADR 0019's command layer stays: one schema and one handler per command, the surfaces as thin adapters, the parity test.

## Consequences
- A status loop, a polling dashboard or a version check cannot grow the log or the state branch.
- `doctor`, `status` and `replay` run without a lease and while the Cellar holds the store.
- There is no audit trail of who looked at what. Foedrum has no such requirement, and keeps no telemetry.
- When the registry grows (#37), each entry says whether it changes state, so the command layer knows which commands must append their events with `by` and `via`, and a test can check that read-only ones append nothing.

## Alternatives considered
- **Record every command, as ADR 0019 said:** a complete audit trail, but reads grow the log and the state branch without bound, must append before they can read, and add a writer next to the engine.
- **Record read-only commands in a separate local log (not the event store):** keeps the event log clean, but is a second store with its own retention and no reader; logs of a running Cellar already show what it did.
- **Record read-only commands from some surfaces only (GitHub comments):** a comment is already visible on GitHub with its author and time, and Foedrum's reaction to it (ADR 0019) shows it was handled; an event would only repeat that.
