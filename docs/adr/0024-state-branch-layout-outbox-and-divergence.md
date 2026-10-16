# 0024. The state branch: layout, outbox and divergence

Date: 2026-10-15 · Status: Accepted · Amends [0002](0002-event-sourced-engine-on-node-sqlite.md) and [0011](0011-state-in-the-brewery-repository.md) · Amended by [0027](0027-supervisor-lost-and-stalled-attempts.md) and [0032](0032-chaos-tests-effects-found-by-key-and-leases-at-start.md)

## Context
[ADR 0011](0011-state-in-the-brewery-repository.md) puts the durable record on the branch `foedrum/state` of the Brewery, committed and pushed at every step boundary, with SQLite as the local index that is rebuilt from the branch. It leaves open how the files rebuild the same store, where events without a batch go, in which order SQLite and git are written, what a step boundary is, what "behind" means, and how ids that become file names stay safe. A rebuild that changes event ids, or a crash between SQLite and git that loses or doubles an event, would break invariant I3 (replaying the log yields identical state) across machines.

## Decision

### Files
- Each line of a log file is one stored event: `{"id":<store id>,"event":<event>}`, as `JSON.stringify` writes it, ending in LF. Readers tolerate CRLF and a BOM.
- An event with a batch lives in `batches/<batchId>/events.jsonl`. `effect.applied` belongs to the batch of its effect key. Events without a batch (`bottle.opened`, `release.observed`, and any later one) live in the top-level `events.jsonl`, in the same line format. Which file an event belongs to is one exhaustive function of the event, so a new event type must be placed before it compiles.
- **Global order:** a rebuild reads every log file, merges the lines by id and appends them keeping their ids, so the rebuilt store has identical ids, events, indexes and folded state. A duplicate id, ids out of order within a file, or an event in a file it does not belong to makes the branch invalid; the rebuild refuses it, naming the file and line.
- The branch carries a `.gitattributes` with `* -text`, added by the first flush, so git never converts line ends: every machine reads the same bytes, whatever its `core.autocrlf`.
- **Out docs** go to `batches/<batchId>/<stepId>-<attempt>.md`, next to `events.jsonl`. The engine writes an out doc into the state worktree before it appends the event that refers to it, so the doc is committed with that event. A crash in between leaves at worst a doc without its event, committed at the next boundary; never an event without its doc.

### Ids are path segments
- Batch and step ids are path segments on every operating system: one shared schema (`src/schemas/ids.ts`) requires `^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$` (lowercase, so `B1` and `b1` cannot share a folder on Windows or macOS; starting and ending with a letter or digit; at most 64 characters, so out-doc paths stay well inside Windows' 260-character limit) and refuses Windows reserved names (`con`, `prn`, `aux`, `nul`, `com1`–`com9`, `lpt1`–`lpt9`, also with an extension such as `nul.txt`). Every `batchId` and `stepId` in the event schemas and the effect key uses it. The state branch relies on the schema and checks once more where it builds a path.
- Foedrum's git runs with `core.longpaths=true` (set through `GIT_CONFIG_COUNT`), so a deep work root on Windows does not make git refuse a path either.
- The remote branch is read from `git ls-remote` by its exact ref (ls-remote also matches refs that only end like it). A remote branch that holds a symbolic link or a submodule is refused before anything of it is checked out: either could lead the engine's reads and writes outside the state worktree.

### Outbox
- SQLite is written first, in its transaction; git follows. The store keeps a **pushed-through marker**: the id of the last event on the remote branch and the commit that holds it.
- At a step boundary the engine flushes: every event after the marker is written to its file (lines after the marker that a crashed flush left on disk are dropped first, so a flush is idempotent), the worktree is committed, the branch is pushed, and only then the marker advances to the last flushed event and the pushed commit.
- A **step boundary** is the append of `step.finished`, or of any event that changes a batch's lane kind (ordered, brewing, conditioning, stuck, on tap, cancelled), including `batch.ordered`. Other events are pushed with the next boundary.
- **Exceptions to ADR 0002 and the engine rules.** The marker is the store's second mutable record, next to leases: it only moves forward and is rebuilt with the store. The state branch's own push is the one external side effect outside the idempotency ledger: a ledger entry for it would be an event that itself has to be pushed. It is idempotent through the marker instead, because a flush rewrites the same lines and git pushes the same commit again.
- A push that fails for another reason (network, a remote hook) leaves the marker where it was. The engine retries it on its supervisor tick, with a deadline that raises the batch's attention when it passes, so unpushed events never wait for a boundary that may not come.
- State commits and pushes run with `--no-verify`: the user's hooks are written for code, and would slow or block every boundary. `--no-verify` skips only pre-commit, commit-msg and pre-push, so every state-branch git call also gets `core.hooksPath` pointing at an empty folder Foedrum owns (`no-hooks`, next to the state worktree in the work root), given through `GIT_CONFIG_COUNT` like `core.longpaths`: post-commit, post-checkout, post-merge and reference-transaction hooks of the clone never run either. The engine refuses to start when that folder is not empty. Signing follows the clone's configuration. At start-up (where `foedrum serve`, and later `foedrum doctor`, call it) the engine makes one test commit, signed when the clone signs, on a throw-away ref in the state worktree, non-interactively with a short timeout, and deletes the ref. It asks for the signature (`-S`) itself, because `git commit-tree` does not read `commit.gpgSign`. When it fails the engine refuses to start, naming the signing setting when signing is on, instead of failing at every boundary.

### Behind or diverged
At start-up the engine fetches the branch and compares its head with the marker and with the state worktree's own head:

| Remote branch | Local store | Result |
|---|---|---|
| at the marker's commit, or at the worktree's head (a push whose marker was not written) | anything | flush what is unpushed, then run |
| missing | empty, or events never pushed | run; the first flush creates the branch |
| missing | a marker | **stop**: the branch is gone |
| ahead of the marker (the marker's commit is an ancestor) | nothing unpushed | **behind**: append the branch's later events with their ids, after checking that every pushed event equals the branch's |
| exists | empty, no marker (database missing) | **rebuild** from the branch |
| exists, no marker | events never pushed | **stop**: diverged |
| ahead of the marker | unpushed events | **stop**: diverged |
| not a descendant of the marker | anything | **stop**: the branch was rewritten |

- A push rejected as non-fast-forward means another engine wrote in between: the engine **stops**.
- A stop is an error that names both heads: the local commit and unpushed events, and the remote commit. Foedrum never merges, rebases or force-pushes the state branch. A human chooses: keep the remote history (move the local database aside; the next start rebuilds it) or investigate the other engine first. A rebuild into an empty store resets the state worktree's local branch to the remote head and removes untracked log files; the remote is never touched, and a diverged local commit stays in the reflog. A store that is behind keeps its events, so it refuses a worktree with changes instead.

### Worktree
- The state branch has its own worktree of the Brewery clone in the work root ([ADR 0012](0012-worktrees-from-local-clones.md)), created from the remote branch, or as an orphan branch when there is none. Foedrum never touches the user's working tree or `main`.
- Git runs through an injected process runner, non-interactively (no terminal or credential prompts) and with a timeout that is a hard deadline: it kills git and every process git started (taskkill `/T` on Windows, the process group elsewhere). State files are written to a temporary file and renamed into place, with a bounded retry while another process holds the target open (Windows). A pure core decides what to write, what to commit and whether to stop; the shell gathers facts and runs git ([ADR 0021](0021-unit-tests-spawn-no-processes.md)).

## Consequences
- A database can be deleted or lost at any time; the next start rebuilds an identical one. Leases are not rebuilt: they have no meaning after a crash.
- At most the events since the last step boundary are lost with the machine; they are within the current step, which is retried (ADR 0011).
- The store gains a pushed-through marker, its last event id and a replay that keeps ids, behind the `EventStore` interface, with a schema migration.
- Batch and step ids are restricted. The recipe schema (#52) must use the same schema for step ids, and the engine must generate batch ids that pass it.
- A divergence needs a human. That is intended: two engines writing one Brewery is the failure ADR 0011 designs out.
- Commit signing problems show at start-up, not mid-batch.

## Alternatives considered
- **Number events per file:** files could be written independently, but a rebuild could not recover the global order across batches, so state and ids would differ.
- **Git first, then SQLite:** a crash after the push and before the database write loses nothing either, but every event would wait for git, and a failed push would block the engine's own transactions.
- **Rebuild by deleting the database when it is behind:** simpler, but it drops leases and takes a full replay where a few events suffice; appending with ids after the prefix check gives the same store.
- **Merge diverged histories:** event logs of two engines cannot be merged without deciding which actions win; that is a human decision.
- **Encode ids into file names:** any id would be allowed, but the folders would be unreadable; a restricted id is readable and safe everywhere.
- **Run the user's hooks:** respects their setup, but a code linter or pre-push test run on every step boundary slows or blocks the engine for files no hook was written for.
