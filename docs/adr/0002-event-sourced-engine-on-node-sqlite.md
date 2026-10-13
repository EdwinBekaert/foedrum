# 0002. Event-sourced engine on `node:sqlite`

Date: 2026-10-13 · Status: Accepted · Amended by [0011](0011-state-in-the-brewery-repository.md)

## Context
Agent orchestrators most often get stuck or inconsistent because state is spread across many files and processes, partially written on crash, and reconciled after the fact. Foedrum must recover from a crash at any moment without losing or duplicating work.

## Decision
- The single source of truth is an **append-only event log**. Current state is a pure fold over events; recovery is replay.
- Leases (renewed every few seconds) live in one small mutable table.
- External side effects (pull requests, comments, pushes) are recorded in an **idempotency ledger** with a `UNIQUE` key `(batch, step, attempt, effect)`.
- Storage is **SQLite through the built-in `node:sqlite`** module, in WAL mode, accessed only through an internal `EventStore` interface.
- Diagnostic text logs are separate plain files; they are not state.

## Consequences
- Appending an event, updating a lease and recording a side effect happen in **one transaction** — never half-written.
- Readers (`foedrum status`, the dashboard) never block the single writer.
- "Never apply a side effect twice" is enforced by the database, not by code paths.
- Queries such as "batches past their deadline" or "events after id N" (for live streaming) are indexed.
- Zero added dependencies.
- Risk: `node:sqlite` is a release candidate (stability 1.2), not yet stable. Mitigated by the `EventStore` boundary; `better-sqlite3` is the fallback.

## Verification
Spike [#16](https://github.com/EdwinBekaert/foedrum/issues/16), Node 24.20.0 (SQLite 3.53.4), Windows 11, 2026-10-13. No experimental warning is printed.

- `PRAGMA journal_mode=WAL` returns `wal`, and the mode persists in the file for later connections.
- With a write transaction (`BEGIN IMMEDIATE`, 1,000 uncommitted inserts) open, a reader in **another process** (`readOnly`, `timeout: 0`) and a second connection in the same process both read at once and see only committed rows.
- A read transaction keeps its snapshot across a concurrent commit; the next read sees the new rows.
- A second writer with `timeout: 0` fails immediately with `database is locked`. The error has `code: 'ERR_SQLITE_ERROR'` and `errcode: 5` (`SQLITE_BUSY`), so the `EventStore` must test `errcode`, not `code`.
- A writer in another process with `timeout: 5000` waits for the lock (about 550 ms in the test) and then commits.
- `PRAGMA wal_checkpoint(TRUNCATE)` succeeds, and the database files can be deleted after `close()` on Windows.

## Alternatives considered
- **JSON files per entity:** no multi-file atomicity, partial writes on crash, locking for readers, drift between files.
- **One append-only JSONL file:** simple and readable, but no atomic multi-record changes, no indexes, and leases still need a separate store.
- **GitHub as the store:** rate limits, latency, and no transactions.
