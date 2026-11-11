# 0380. A cleanup recipe archives finished batches on the state branch and sweeps old temporary files

Date: 2026-11-11 · Status: Accepted · Amends [0025](0025-batch-lifecycle-stuck-reminders-and-rewind.md) (on tap and cancelled are no longer terminal for a reopen, which a retry returns), [0219](0219-a-failing-check-on-an-open-pull-request-sends-its-batch-back-to-a-fix-step.md) (Stuck from on tap also for a reopen), [0024](0024-state-branch-layout-outbox-and-divergence.md) (a third folder on the state branch, `archive/`, which the engine reads nowhere, and a catch-up that skips what it moved), [0345](0345-a-pull-request-past-a-skip-says-so-and-an-ended-batch-s-status-comment-is-left-alone.md) (a batch with no pull request ends once the engine closed its issue, and a reopen clears `endShown`), [0335](0335-a-batch-that-keeps-failing-is-marked-after-an-hour-and-stuck-when-a-reading-hides-its-deadline.md) (a mark on an ended batch reopens it, Stuck), [0365](0365-a-recipe-has-a-type-mash-or-brew.md) (a third type, `tend`, offered to no step), [0071](0071-the-openpullrequest-action-two-effects-of-the-batch.md) (two more actions the engine runs, anywhere in a recipe) [0296](0296-a-target-repository-s-pull-request-names-no-brewery-issue-and-the-engine-closes-it.md) (a `tend` batch's issue closes once it is on tap with no pull request, and `close.issue` now ends a batch with none), and [0375](0375-every-recipe-offered-as-a-choice-carries-guidance-the-models-that-choose-read.md) (a `tend` recipe needs no guidance, since none is offered)

## Context
A batch that has ended is still handled on every pass: `applyPass` asks each source of effects about every batch in the store, so an upgrade that changes a comment's text could write to a closed batch (#825, #920).
The event log kept every batch for as long as the Brewery lived, and nothing cleared a Brewery's `.foedrum/tmp/` (#828).

The maintainer's rule (2026-11-07): **a closed batch is done, and nothing happens to it.**
If something fails after a batch closed and its issue needs more work, the batch is reopened with a failing state, so something acts on it.
Decided with the maintainer (2026-11-11): the archive is a folder on the state branch, and the cleanup is an ordinary recipe that a Brewery issue's label starts, with no trigger, schedule or command of its own.
The rest was settled from the code (#921).

## Decision
### What counts as finished
- **`batchEnded` is the one rule** (`src/engine/fold.ts`): cancelled; or on tap with pull requests that all ended; or, new, on tap with none once the engine closed its Brewery issue (`issueClosed`, set when the ledger records `close.issue`).
  That covers a split order whose sub-orders all merged ([ADR 0293](0293-a-split-order-ends-once-every-sub-order-merged-and-the-engine-closes-it.md)) and a cleanup's own batch.
  A batch with one of two pull requests still open has not ended.
  When #834's state function comes, it is to build its "Done" on it, so there stays one rule.
- **The cleanup takes more than an end** (`archivable`, `src/engine/archive.ts`): no effect of the batch still due, or a source that cannot say; no mark; no batch or attempt lease; and every batch of its family, the order it was split from and its sub-orders, takes the same test, since a live sub-order reads its order and its siblings (a release blocker, the plan entry).
  A family goes whole or not at all.
  A batch goes only with every earlier batch of its issue, so the index's last entry for an issue is the batch ordered last, which a later batch of the issue reads.

### The archive
- **`batch.archived`** records each, in the top-level `events.jsonl`, since its batch's own log moves: the batch, its order, the Brewery issue it leaves for a later batch of its issue, the plan comment its order showed, and how it ended (`cancelled`, `merged`, `closed`, `issue_closed`).
  Only an ended batch is admitted; a second archive, and any event of an archived batch, is refused (`batch <id> is archived`), and its id is never ordered again.
- **The fold takes the batch out**, with what only its own events made: its ledger entries, its merges, with the positions after them moved down, its place in its order or sub-order, and a breakdown no batch still in the fold holds.
  So the folded state is the one a store rebuilt from `batches/` alone folds, and `state.archived` keeps the event's fields as an index.
- **The flush moves its folder:** the flush that writes `batch.archived` first writes the batch's last lines, then renames `batches/<id>/` to `archive/<id>/`, out docs and all.
  A flush retried after the move, whose push or commit failed so the marker still holds its events, first moves the folder back, so the batch's log is written whole and moved again.
  Nothing is deleted from git history.
- **The engine never reads `archive/`.** A rebuild reads `batches/` and the top level (ADR 0024, unchanged), and a store behind the branch skips its own events of a batch the branch archived, which left `batches/` (`planCatchUp`).
  The local database keeps those rows until it is next rebuilt: its triggers refuse deletes, and the fold reads past them.
  The wiring reads the facts of `archivable` from the driver's sources and the store (`storeFacts`).
  `applyPass`, the supervisor, the intake and the board walk the fold, so none goes over an archived batch.
- **What still reads an archived batch reads the index:** the next batch id of its issue (never one it used), a later claim of its target issue (the Brewery issue it opened, and the intake counting the issue as brewed, so it is never claimed again), a later batch's plan comment (the one it showed), `foedrum status <n>` (`#<n>: batch <id> is archived (<end>)`) and `foedrum resume` (refused by name).
  The reports (`brewers`, `lenses`, `status <order>`'s tokens) cover the batches in the fold only.

### The recipe
- **`tend`, a third recipe type:** it neither plans nor builds, and no step is offered one, neither a step that chooses a recipe nor a plan, so it needs no guidance and only its label starts it.
- **Two actions the driver runs itself** ([ADR 0071](0071-the-openpullrequest-action-two-effects-of-the-batch.md)), each one effect keyed by its attempt, found by the ledger alone: `archive` records `batch.archived` for every batch `archivable` takes but its own, and keeps the ids; `sweep` removes each entry of the Brewery's `.foedrum/tmp/` whose newest file or folder inside changed more than 2 days ago, links read as themselves, and keeps what it removed and what it could not.
  Either may come anywhere in a recipe; the driver picks a step's actions by the action it is (`actionsByKind`).
- **The default `cleanup`** (`defaults/recipes/cleanup.jsonc`) is `archive`, then `sweep`.
  A person labels a Brewery issue `recipe:cleanup`; `foedrum brew <n>` or serve's intake runs it like any order.
  Its batch goes on tap with no pull request, the engine closes its issue (`The cleanup is done; Foedrum closes this issue.`), which ends it, and the next cleanup archives it.
- **What it leaves alone:** a running attempt, a held lease, a Stuck batch a person may retry or resume, a batch with an effect due (unpushed commits are kept on their branch by [ADR 0084](0084-a-batch-s-commits-end-in-a-pull-request-or-on-a-kept-branch.md) and reported by the worktree cleanup), and in `.foedrum/tmp/` a folder in which anything changed in the last 2 days.
  Attempt worktrees, attempt settings, the Brewery order checkouts and the work root's git folders already go with their batch or by age ([ADR 0029](0029-attempt-worktrees-layout-claims-and-repair.md), [ADR 0130](0130-the-cleanup-removes-the-git-directories-of-its-own-a-stopped-call-left.md)); the sweep reads only the Brewery's `.foedrum/tmp/`, where Foedrum itself writes nothing.

### The reopen
- **A failure after the close that needs more work** is a batch that ended and whose passes then failed for an hour: an effect due after its end (the closing comment, the claim's release, the issue's close, a pre-existing finding's issue, the last status revision) failing that long.
  One that recovers within the hour is a retry of an effect and changes nothing.
- **The mark reopens it** (`mark_failing` on an ended batch): `batch.failing` and, in the same decision, `batch.stuck` with the reason `reopened`, which keeps the lane it ended in.
  The reopen clears `endShown`, so its status comment takes revisions again, and `batchEnded` no longer holds, so no cleanup takes it.
  Its reminder renews it as any Stuck's.
- **A person acts on it**, as on any Stuck: `retry` returns it to the lane it ended in, its mark gone, so its effects run again with a new hour; `cancel` ends it.
  `foedrum status` says `reopened after it ended: failing in <pass> since <time>: <summary>`, the status comment `it had ended, and then the <pass> pass failed for an hour since <time>: <summary>`, filtered as any summary.
- **Never from `archive/`:** an archived batch had nothing due, so nothing of it can fail; a later need of its issue is a new batch.

## Consequences
- **What an existing Brewery must do: nothing.** Foedrum has no release, so no state branch laid out before `archive/` needs anything; a Brewery that wants a cleanup labels an issue `recipe:cleanup`, which `foedrum init` does not create.
- An older Foedrum cannot read a state branch that holds `batch.archived` or a Stuck reason `reopened`, as with any added event.
- A store rebuilt from the branch has fewer rows than the one that archived, and the same folded state.
- A batch reopened from on tap no longer records its pull requests' checks while Stuck; it ended, so it had none open.
- A resume of a Stuck batch now ends its reminder's deadline in the store's index itself, where a step scheduled next ended it before.

## Alternatives considered
- **Archive in git history only (delete the folder).** The branch would hold nothing to read on purpose later, for a person or a future reopen; the move keeps every file readable at the head.
- **A third definition of finished for the cleanup.** Two rules for one word drift apart; the cleanup's extra conditions are facts the fold has not (leases, effects due), so they stay beside the rule.
- **Delete the archived batch's rows from the local database.** It would drop the store's delete triggers, the guard of the ledger (I4), for rows the fold reads past.
- **`brew` with an "offered: false" flag.** One more field to forget on a recipe that is never a choice; the type says what it is.
- **Restore a batch from `archive/` to reopen it.** Its events' ids lie below the archive's, so the fold would have to rebuild the batch from events it then copies forward; with nothing due at the archive, there is nothing to reopen it for.
