# 0011. State in the Brewery repository

Date: 2026-10-13 · Status: Accepted · Amends [0002](0002-event-sourced-engine-on-node-sqlite.md)

## Context
[0002](0002-event-sourced-engine-on-node-sqlite.md) puts the event log in a local SQLite file. If that machine is lost, so is every batch's history. The Brewery is already a git repository: versioned, pushed, reviewable. Users want no state loss and the ability to go back to an earlier point in a batch.

## Decision
- The **durable record** lives in the Brewery repository on a dedicated branch, **`foedrum/state`**: per batch a folder `batches/<id>/` with an append-only `events.jsonl` and the batch's out docs.
- State is **committed and pushed at every step boundary**, not on every lease renewal.
- **SQLite remains** the local index and working store (transactions, leases, queries). `foedrum serve` rebuilds it from the state branch when it is missing or behind.
- **Single active engine:** a push rejected as non-fast-forward means another engine wrote in between; the engine stops rather than diverging.
- **Rewind:** each step records the commit SHA of every repository it touched. Rewinding to a step resets the batch's branches to those SHAs and appends a `batch.rewound` event; history is never rewritten.
- **Idempotent external effects survive machine loss:** branch names are deterministic, and existing pull requests are looked up by branch before one is created.
- `main` keeps configuration (brewers, recipes, house yeast) only.

## Consequences
- A new machine continues where another stopped.
- Every plan, review and decision is readable in git and linkable from issues.
- At most the current step's work is lost on a crash; it is retried.
- Commits on the state branch are frequent; keeping them off `main` avoids noise.
- Leases and diagnostics stay local; they have no meaning after a crash.

## Alternatives considered
- **Commit the SQLite file:** binary, changes every few seconds, cannot be merged or read.
- **State on `main`:** visible, but floods the configuration history.
- **A separate state repository:** clean separation, but one more repository to create, secure and keep in sync.
