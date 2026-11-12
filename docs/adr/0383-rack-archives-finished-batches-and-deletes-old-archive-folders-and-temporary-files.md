# 0383. Rack archives finished batches, and deletes old archive folders and temporary files

Date: 2026-11-12 · Status: Accepted · Amends [0002](0002-event-sourced-engine-on-node-sqlite.md) (the store deletes for the archive only), [0024](0024-state-branch-layout-outbox-and-divergence.md) (the archive folder of the state branch), [0053](0053-recipe-files-reach-the-engine-brewer-steps-in-a-line-first.md) (a human gate and rack's actions load), [0281](0281-foedrum-approve-signs-off-a-plan-by-its-hash-and-puts-the-batch-on-tap.md) (approve also lets a gate go on), [0275](0275-a-finished-plan-waits-stuck-for-its-review-and-every-comment-links-the-doc-it-sums-up.md) (a human gate waits Stuck as `plan_review` too), [0345](0345-a-pull-request-past-a-skip-says-so-and-an-ended-batch-s-status-comment-is-left-alone.md) (when a batch with no pull request is done, for the archive) [0365](0365-a-recipe-has-a-type-mash-or-brew.md) (a recipe with no brewer, as rack, is of type `brew`), [0375](0375-every-recipe-offered-as-a-choice-carries-guidance-the-models-that-choose-read.md) (a recipe with no brewer is never offered) and [0385](0385-a-person-reads-a-batch-as-one-of-four-states.md) (a batch at a human gate waits for your go, and one on tap after it is done)

## Context
A Brewery's store and state branch keep every batch it ever brewed, and its `.foedrum/tmp/` keeps what sessions left there (#921).
The maintainer decided on 2026-11-12: a recipe, `rack`, started like any order by a Brewery issue labelled `recipe:rack`, waits for a person's go, then archives the finished batches, deletes archive folders older than six months and temporary files older than two days.
The recipe schema had a `gate: "human"` step and an `action` step the engine refused (ADR 0053).
Not part of it: a new batch id format, recipe type, role, label, command or event format, a reopen of a closed batch, and a schedule (#1012).

## Decision
### The gate
- A `gate: "human"` step loads. Its attempt is started and ended at once by the driver, with no runner and no code host, and the output `{ "gate": "human" }`.
- The batch then waits Stuck as `plan_review` on that attempt, with the label `foedrum:awaiting-approval` and the options a plan's review has. No event changes.
- `foedrum approve` records `batch.approved` with that attempt's digest, as for a plan, and for a gate goes on to the recipe's next step instead of on tap.
- The gate's required `deadline` is only its attempt's, which ends at once. The wait for the person is a Stuck batch's, with its reminders, as a plan's review is.
- Every surface reads such a batch as waiting for you to give your go (`batchState`, ADR 0385): the status comment says `` Waiting for you: give your go: run `foedrum approve <n>` `` and, as `foedrum stuck` does, `` go on with `foedrum approve <n>`, or end it with `foedrum cancel <n>` ``. After its approval, a rack batch on tap with no pull request reads done: a gate's approval is no plan's (`planApproval`).

### Rack's actions
- `archive`, `deleteArchives` and `deleteTemporary` are actions the engine runs itself, as openPullRequest is (ADR 0071): one effect per attempt through the ledger (`rack.archive`, `rack.delete-archives`, `rack.delete-temporary`), each done again as it is when a crash comes before its record. Each ends succeeded with what its effect did.
- The two deletes need an `olderThan` (the `Duration` of a step's deadline), and no other action takes one. The default `defaults/recipes/rack.jsonc` has `180d` and `2d`; a Brewery changes them with its own `rack.jsonc`.
- A recipe with no brewer, as rack, is never offered to a model as a choice: a person starts it. Rack is of type `brew`: it plans and chooses nothing, and with no brewer it spends no tokens either way, so the type only keeps it out of what a plan's sub-orders may name.

### What is archived
- A batch is finished when it ended with its status comment showing it (`batchEnded` and `endShown`), or is on tap with no pull request, with no Brewery issue close still due and, for a claimed batch, its claim released. These are the effects that act on what stays: the close and the release change an issue a person may order again. A batch on tap with no pull request is archived only once a person closed its issue, so a status comment or label revision still due there would change a closed issue's text only, and is let go.
- Batches go together: every batch of an issue, and a split order with every sub-order's batch, once all of them are finished. A parent without its sub-orders would stop the fold, and an older batch without the later one would lose its claimed order.
- And only once every issue of the group is closed on GitHub, read through the code host, once per issue in each run: the Brewery issue, and a claimed batch's target issue too. An open issue with no batch is a new order to the intake, so a batch whose issue is open stays. A rack batch counts as finished once its issue is closed. To drop work, a person cancels the batch and closes its issue.

### Archiving a batch
- The store deletes the batch's rows first, its events and every index kept for it (`forget`, in one transaction), in chunks of the groups whose issues read closed: every 25 groups, or once 20 s passed since the last forget, and when the run ends or a read fails, so a run cut off by the effect's deadline still gets further, and a long history costs a few forgets and folds, not one per group. Right before each forget, with no wait between, the chunk's groups are checked again: one a batch joined while its issues were read stays. Then the state worktree's `batches/<id>/` moves as it is to `archive/<date>/<id>/`, under the writer lock (ADR 0107). The flush at the rack step's end commits the move with the step's events, one commit, pushed.
- A crash after the forget and before the move leaves the branch with a folder the store lacks. The pushed marker is unchanged, so the next start is `ready`; the next rack run moves every `batches/` folder whose batch the store lacks. Pushing first instead would leave the remote ahead of the marker, and the next start's catch-up would stop the engine on a local event the branch lacks.
- Once pushed, the store and the branch agree: a start finds the marker at the remote head, and a rebuild reads only `batches/` (`isLogPath`), never the archive.
- Foedrum never reads a file of the archive, and nothing is deleted from git history.

### The store
- ADR 0002's append-only rule keeps one exception: rack's archive. Migration 5 adds the table `forgetting`. The triggers that refuse a delete of `events` and `effects` refuse it unless that table has its row, which `forget` writes and takes away in its own transaction.
- `forgotten()` counts a connection's forgets; the command log folds again from the first event when it changes.

### Deleting
- `deleteArchives` deletes each `archive/<date>/` whose last day ended more than its `olderThan` ago, in an ordinary commit, under the writer lock.
- `deleteTemporary` deletes the files under the Brewery's `.foedrum/tmp/` changed more than its `olderThan` ago, by modification time, and the folders that leaves empty. It never follows a link, and leaves a file it cannot delete for the next run. No product code writes there: what is there is sessions' and tests' scratch, and a running one's files are newer than two days. Attempt worktrees keep their own cleanup (ADR 0029).

### Batch ids
- `nextBatchId` and `targetBatchId` skip an id that is a folder name under `archive/<date>/`, or under `batches/`, where a forget leaves a folder until its move, read from the state worktree by folder name only, in the intake, `foedrum brew`, `order` and `recipe`. An archived id is not given out again while its folder exists.

## Consequences
- **What an existing Brewery must do: nothing.** Foedrum has no release. The store migrates itself to version 5, and `rack` comes from the defaults.
- An archived id is skipped only while its folder exists. An issue ordered again more than 180 days after its archive folder was deleted can be given the same batch number, and the lookups of its pull request (by branch, open or not) and of its status comment (by marker) can then find the old ones. The maintainer accepted this; nothing is built against it.
- A second process beside serve, such as `foedrum brew`, keeps its fold of an archived batch until it restarts: its connection did not forget. Nothing is built for that.
- An archived batch is gone from `foedrum status`, `resume`, `replay` and `<n>`; its issue's number names an older batch, or none.
- A cancelled batch is archived only once a person closes its issue; cancel closes neither the issue nor a pull request.
- The worktree cleanup sees an archived batch as unknown: a clean worktree left of it goes, and a branch left of it is kept and reported, as for any batch the store does not know (ADR 0029). The end of the batch's own cleanup normally removed them before.
- A top-level event that names an archived order (a rank, a pause) stays in the state as it is; none of them reads a batch.

## Alternatives considered
- **A Stuck reason of its own for the gate.** Clearer words, but a change to the event format, which #921 rules out; `plan_review` already gives the label and the approve.
- **Push the archive first, then forget.** See above: a crash between them stops the engine at its next start.
- **Archive a batch whose issue is open.** The intake would order the issue again.
- **Keep a table of archived ids in the store.** Foedrum keeps nothing of an archived batch; the folder names suffice for ids.
