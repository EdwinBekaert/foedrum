# 0475. The watch board leads with the Brewery issue's number and puts a batch's message on a line under its row

Date: 2026-11-28 · Status: Accepted · Amends [0428](0428-a-failed-check-a-stuck-batch-and-the-watch-board-say-what-happened-and-what-follows-in-plain-words.md) (the order of the board's cells and the age's word), [0188](0188-foedrum-status-watch-redraws-a-board-of-the-live-batches.md) (the lines under a row), [0335](0335-a-batch-that-keeps-failing-is-marked-after-an-hour-and-stuck-when-a-reading-hides-its-deadline.md) (a board row whose rendering throws shows the number, not the id) and [0385](0385-a-person-reads-a-batch-as-one-of-four-states.md) (the board's row no longer leads with the id)

## Context
ADR 0428 led each row of `foedrum status --watch` with the state and the batch's whole detail, then its id, its order and `age 1m 23s`, so a narrow terminal would cut the ids and the age rather than the step and the reason.
On 2026-11-28 the maintainer watched four batches on a wide terminal. A Stuck batch's detail (`look at a failure: stalled at gauge since … ; reminder …; 3 attempts / 14m 2s / 199 turns / 13.4M tokens / 1 denied`) ran to about 190 characters, and the columns align every row to the widest, so the id and the order of every row fell past the right edge: no row said which batch it was.
An age over an hour read in minutes, `age 1042m 50s`.

## Decision
- A row of the board holds short cells only: the Brewery issue's number (`#45`, or, for a batch with no Brewery issue yet, its target issue as `foedrum status` names it, `acme/app#7`), the state, what the batch does or waits for in a few words, what its attempts took, and its age.
  For example `#45  waiting for you  look at a failure  3 attempts / 14m 2s / 199 turns / 13.4M tokens  2h 18m`.
- The rest of what `foedrum status` says of the batch (a Stuck reason and its reminder, a wait's reminder, the pull requests to merge, a pause, a failing mark) goes on a line of its own under the row, indented by two spaces as an attempt's line is, before the attempts' lines: `  stalled at gauge since 2026-11-28 10:56 UTC (1 h 6 min); reminder 2026-11-30 10:57 UTC`.
  A narrow terminal cuts that line at its end; it is dropped with the attempts' lines when the board is too tall.
- The few words are those before the reason (`look at a failure`, `merge a pull request`), or a running or waiting batch's detail up to its first `; `.
- The board shows no batch id, and no target issue beside a Brewery issue's number: `foedrum status` still shows both.
  A batch whose rendering throws is shown by its number too, with `cannot be read` and its mark on the line under its row.
- The age has no word before it, and an age of an hour or more reads in hours and minutes, `17h 22m`, as every time `elapsed` writes does: the live line's, the board's, `foedrum brew`'s `running for` lines and `foedrum serve`'s lasting lines.

## Consequences
- Every row of a board stays as wide as its short cells, so the number and the age stay in view whatever a batch's reason.
- A Stuck batch takes two lines of the board's height; on a short terminal its message line goes before any row does.
- Code: `boardRow` and `describeState`'s `short` and `message` in `src/cli/status.ts`, the rows in `src/cli/status-watch.ts`, `elapsed` in `src/cli/live-line.ts`.
- By hand in an existing Brewery: nothing.
