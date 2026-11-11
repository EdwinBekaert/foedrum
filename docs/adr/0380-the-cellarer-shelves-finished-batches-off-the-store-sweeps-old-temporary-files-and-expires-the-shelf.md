# 0380. The Cellarer shelves finished batches off the store, sweeps old temporary files and expires the shelf

Date: 2026-11-12 · Status: Accepted · Amends [0002](0002-event-sourced-engine-on-node-sqlite.md) (the store forgets a shelved batch's rows, the one delete it allows), [0024](0024-state-branch-layout-outbox-and-divergence.md) (a third folder on the state branch, `archive/`, that the engine never reads, and a catch-up that forgets what another store shelved), [0050](0050-the-intake-of-target-repository-issues.md) (batch ids carry the time they were ordered), [0071](0071-the-openpullrequest-action-two-effects-of-the-batch.md) (three more steps the driver runs itself), [0296](0296-a-target-repository-s-pull-request-names-no-brewery-issue-and-the-engine-closes-it.md) (a `tend` batch's issue closes once it is on tap with no pull request, and `close.issue` ends a batch with none), [0345](0345-a-pull-request-past-a-skip-says-so-and-an-ended-batch-s-status-comment-is-left-alone.md) (a batch with no pull request ends once the engine closed its issue), [0365](0365-a-recipe-has-a-type-mash-or-brew.md) (a third type, `tend`) and [0375](0375-every-recipe-offered-as-a-choice-carries-guidance-the-models-that-choose-read.md) (a `tend` recipe needs no guidance, since none is offered)

## Context
A batch that has ended is still read on every pass: `applyPass` asks each source of effects about every batch in the store, so an upgrade that changes a comment's text could write to a closed batch (#825, #920).
The store and the state branch kept every batch for as long as the Brewery lived, and nothing cleared a Brewery's `.foedrum/tmp/` (#828).

The maintainer's rule (2026-11-07): **a closed batch is done, and nothing happens to it.**
A first design (#1009, closed unmerged) kept an archived batch's events in the store and an index of archived batches in the fold, so ids, claims and plan links could still read them, and reopened a batch whose effects failed after its end.
Decided with the maintainer (2026-11-12): the archive is for people only.
Foedrum keeps no record of a shelved batch, reads nothing from `archive/`, and never reopens a batch; the cleanup's steps are the Cellarer's, engine code with no model.

## Decision
### Batch ids need no memory of old batches
- **A batch id carries the time it was ordered**, to the second in UTC: `<issue>-<yyyymmddhhmmss>` for a Brewery issue, `<alias>-<issue>-<yyyymmddhhmmss>` for a claimed target issue (`nextBatchId`, `targetBatchId`, `src/engine/batch-id.ts`), with `-2`, `-3`… only when a batch in the fold already has that id, as two orders of one issue in the same second.
  So an id is never used twice although the store forgets the batches that used it: the clock moved on.
  It has no random part, so a test and a replay make the same id from the same clock.
  At most 20 + 1 + 16 + 1 + 14 and a suffix: under the 64 characters a `PathSafeId` allows.
- The order commands, the intake and the tests' event sequences pass the order's time in.

### What counts as finished
- **`batchEnded` stays the one rule** (`src/engine/fold.ts`): cancelled; or on tap with pull requests that all ended; or, new, on tap with none once the engine closed its Brewery issue (`issueClosed`, set when the ledger records `close.issue`).
  That covers a split order whose sub-orders all merged ([ADR 0293](0293-a-split-order-ends-once-every-sub-order-merged-and-the-engine-closes-it.md)) and a cleanup's own batch.
- **Shelving takes more than an end** (`archivable`, `src/engine/archive.ts`): every batch of its family (the order it was split from and its sub-orders) has ended, has no mark, no batch or attempt lease, no effect still due (a source that cannot say counts as due) and nothing the state branch does not have yet (an event past the pushed-through marker, or an out doc the store keeps).
  A family goes whole or not at all, since a live sub-order reads its order and its siblings.

### The Cellarer
- **The Cellarer is engine code with no model, prompt or tokens**: a step names its job, `{ "id": "shelve", "cellarer": "shelve" }` (`CellarerStep`, `src/schemas/recipe.ts`), and the driver runs it itself as an action, one effect keyed by its attempt and found by the ledger alone (`cleanupActions`, `src/engine/cleanup-actions.ts`), as it runs `openPullRequest` ([ADR 0071](0071-the-openpullrequest-action-two-effects-of-the-batch.md)).
  Its result is the effect's recorded output (`CellarerOutput`, `src/schemas/cellarer.ts`).
- **`shelve`** forgets every batch `archivable` takes but its own: in one transaction the store deletes their events, ledger entries, kept out docs, deadlines and leases, and records each with the month, `YYYY-MM` in UTC, it was shelved in.
  The next flush moves each one's folder from `batches/<id>/` to `archive/<YYYY-MM>/<id>/` and, after the push, clears the record.
- **`sweep`** removes each entry of the Brewery's `.foedrum/tmp/` whose newest file or folder inside changed more than 2 days ago, reading links as themselves, and keeps what it removed and what it could not.
  Attempt worktrees, attempt settings, order checkouts and the work root's git folders already go with their batch or by age ([ADR 0029](0029-attempt-worktrees-layout-claims-and-repair.md), [ADR 0130](0130-the-cleanup-removes-the-git-directories-of-its-own-a-stopped-call-left.md)).
- **`expire`** records the month 6 months before the current one; the next flush deletes every `archive/<YYYY-MM>/` before it from the branch's head, and after the push clears the record.
  Git history keeps what it deletes.
- **The status comment and `foedrum status` name the Cellarer**: a finished step reads ``- ✅ `shelve`: the Cellarer shelved 3 finished batches``, `swept 2 old entries of .foedrum/tmp/` (and `could not remove 1`) or `expired the shelf's months before 2026-05`, and a running one `the Cellarer at shelve #1`.
  The other engine actions stay as they are.

### The store forgets, and the branch keeps the shelf for people
- **The store's one delete** (`forget`, `src/engine/sqlite-event-store.ts`, migration 5): its triggers refuse a delete of an event or a ledger row unless the row's batch is in the transaction's `forgetting` table, which `forget` fills before its deletes and empties after them.
  Every other delete is refused as before, so the ledger's guard (I4) holds for every batch the store keeps.
- **The fold never sees a shelved batch**: a command log folds again from empty when the store's count of forgets changed (`createCommandLog`).
  `applyPass`, the supervisor, the intake and the board walk the fold, so none goes over a shelved batch.
- **Another store catches up by forgetting too**: a batch whose events lie at or below the pushed-through marker and whose folder is no longer in `batches/` was shelved elsewhere, and `restore` forgets it before the catch-up (`forgottenOnBranch`, `src/engine/state-branch.ts`).
- **The engine never reads `archive/`.** A rebuild reads `batches/` and the top level, as before.
- **Nothing remembers a shelved batch.** `foedrum status <n>` of an issue whose only batch was shelved finds no batch; a later order of its issue is a new batch with a new id; a claimed target issue whose batch was shelved while it is still open, its pull request closed unmerged and its claim released, may be claimed again, as an issue that needs more work.

### The recipe
- **`tend`, a third recipe type**: it neither plans nor builds, and no step is offered one, neither a step that chooses a recipe nor a plan, so it needs no guidance, and only its label starts it.
- **The default `cleanup`** (`defaults/recipes/cleanup.jsonc`) is `shelve`, `sweep` and `expire`.
  A person labels a Brewery issue `recipe:cleanup`; `foedrum brew <n>` or serve's intake runs it like any order.
  Its batch goes on tap with no pull request, the engine closes its issue (`The cleanup is done; Foedrum closes this issue.`), which ends it, and the next cleanup shelves it.

## Consequences
- **What an existing Brewery must do: nothing.** Foedrum has no release, so no store or state branch from before needs a migration; a Brewery that wants a cleanup labels an issue `recipe:cleanup`, which `foedrum init` does not create.
- A batch's history after its shelving is in `archive/` for 6 months and in the state branch's git history after that; Foedrum reads neither.
- A plan comment's link to a shelved batch's plan points into `batches/`, which no longer holds it; a person finds it under `archive/`.
- An older Foedrum refuses a store this one migrated, as with any migration.

## Alternatives considered
- **Keep the events and an index of archived batches** (#1009): every reader of an old batch (ids, claims, plan links, status) had to learn the index, and the store kept growing.
- **Ids from a counter kept outside the batches**: one more piece of state to keep in step across machines; the clock is already there.
- **A random part in the id**: tests and replays would no longer make the same id from the same clock.
- **Reopen a batch whose effects fail after its end**: a closed batch is done; a failure that needs more work is a new order.
- **A brewer for the cleanup**: deciding which batch is finished is a fold's question, and a model would spend tokens on it (CLAUDE.md, Engine rules).
