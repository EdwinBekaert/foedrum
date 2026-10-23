# 0154. Lane labels on the order's issue, and the status comment's path line

Date: 2026-10-23 · Status: Accepted · Amends [0072](0072-the-status-comment-edits-as-revisions-in-the-ledger.md) (the comment shows the attempts in the order they ran, and the lane labels are a third source of the driver's effects)

## Context
The first order Foedrum brewed on itself (#374, batch `1-1` for #401) went Stuck at its red proof, and its issue showed where it was badly (#406):

- **No lane on the issue.** `docs/design/humans/github.md` names labels that mirror the lanes, but none was built: an issue list cannot show which orders are brewing, stuck or on tap.
- **The steps in the recipe's order hide the path.** The status comment lists the recipe's steps in order, each with its latest attempt. The trial ran `gauge` #1 ✅, then `red` #1 ❌, then `gauge` #2, which stopped as blocked: the list put the 🔔 on `gauge`, above the ❌ on `red`, so it read as stuck before the red proof.

The folded state keeps each step's attempts by number, but not the order in which attempts of different steps ran; the comment is rendered from the folded state alone (ADR 0072).

## Decision

### The path line
- **The fold keeps a batch's `path`**: each attempt's step and number, appended when its `step.started` is folded, so in the order the attempts started across the batch's steps. It is absent while no attempt has started. A rewind or a recipe change keeps it: it is what ran.
- **The status comment shows it on one line before the step list**: ``Path: `gauge #1` ✅ → `red #1` ❌ → `gauge #2` 🔔``, each attempt marked as the step list marks it (✅ succeeded, ❌ failed, ❓ asked for input, ⏹️ stopped, ▶️ running, 🔔 where the batch is Stuck). Each attempt is a code span: GitHub links a bare `#1` to issue 1.
- The path changes only at an attempt's start or end, so the comment still changes at step boundaries and lane changes alone, and its revisions stay within one a minute (ADR 0072).

### The lane labels
- **Every batch of a Brewery issue keeps one lane label on that issue**: `foedrum:ordered`, `foedrum:brewing`, `foedrum:conditioning`, `foedrum:stuck` or `foedrum:on-tap`, the others taken off. A cancelled batch keeps none. Labels that are not lane labels stay as they are. Names compare without case, as GitHub's do.
- A claimed target-repository issue gets no lane label: it keeps only `foedrum:claimed` (ADR 0050), for the reason it gets no status comment (ADR 0072).
- **Each change is an effect of its own**, keyed `[batchId, "label.<n>"]` with revisions numbered from 1, as the status comment's `status.<n>` (ADR 0072). A revision records `{ label }`, the lane label it left on the issue, or `null` when it took them off. It is due when the batch's lane label is not the latest revision's; a batch cancelled before its first label has none due.
- **Find**: the issue's labels are read; the revision is found when the issue carries its label and no other lane label (or none, for `null`). So a run killed after setting the label and before recording it finds it set.
- **Apply**: when the label is not on the issue, it is made in the Brewery first (`POST /repos/{owner}/{repo}/labels`, GitHub's `already_exists` counting as made) and then added; then every other lane label on the issue is taken off.
- A lane changes a few times in a batch's life, so the labels need no limit of their own beside the client's pause on GitHub's limits (ADR 0052).
- The status comments, the lane labels and the claim effects are the sources the driver applies together (`combineEffects`), in `foedrum serve` and `foedrum brew` alike.

## Consequences
- An issue list in the Brewery filters orders by lane, and a person reading the status comment sees the path the batch took before the step list.
- `Batch` gains `path`; the fold's invariants are unchanged (it only appends, from the events).
- A lane change costs two to four GitHub requests: a read of the issue, and the label's making, adding and the removal of the one before.
- The tests apply the labels with a fake of the labels host and through `foedrum brew` against the fake GitHub API; none reaches GitHub (ADR 0021).

## Alternatives considered
- **Order the step list by when each step last ran:** no new state, but it would move the recipe's not-reached steps around and still show only each step's latest attempt, not the ones before.
- **Keep a start time on each attempt and sort by it:** the order of the events already is the order the attempts started, and two attempts started in one tick would sort as a tie.
- **One effect per label added and per label removed:** each idempotent alone, but a lane change would be several keys, and a run killed between them would leave two lane labels until the next.
- **Set the labels outside the ledger at every pass:** simpler, but a request per order every tick, and an external side effect outside the ledger (I4).
