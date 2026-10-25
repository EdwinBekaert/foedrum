# 0188. `foedrum status --watch` redraws a board of the live batches

Date: 2026-10-25 · Status: Accepted · Amends [0174](0174-foedrum-brew-keeps-a-live-line-on-a-terminal.md) (its terminal rule and text rules also hold for a board of several lines) and [0179](0179-the-live-line-redraws-in-place-and-leads-with-the-batch-s-time.md) (a board redraws in place as the live line does)

## Context
`foedrum status` prints each batch's row once and exits (ADR 0092, ADR 0172). Following several batches means running it again and again. `foedrum brew` keeps a live line on a terminal for the one batch it drives (ADR 0174), and #442 decided (2026-10-24) that a view of many batches belongs to `status --watch`, not to `serve` (#463).

`brew`'s line shows each running attempt's turn and last tool from the brewer's stream, which only the driver that runs the attempt reads (ADR 0047). `status` reads the Brewery's store and holds no lease. The store knows each batch's lane, its steps' attempts and their phases, and, since ADR 0179, when the batch was ordered; it holds no turn, no tool and no time for an attempt. The maintainer chose (2026-10-25) that the board shows what the store knows; a running attempt's turn and tool on the board would need the driver to record them, which is a change of its own.

## Decision

### When
`foedrum status --watch` runs only where `brew` draws its live line: standard output is a TTY, `TERM` is not `dumb`, and `CI` is not set (ADR 0174). Elsewhere it prints one line, `foedrum status --watch needs a terminal; foedrum status prints the batches once`, and exits with 1. `watch` is a flag of `status` in the command registry, run by a function the terminal gives the command layer, as `brew`'s driver is (`context.brew`, ADR 0123). The plugin and GitHub comments have no terminal, so the rule above refuses it there; neither offers it.

### What it reads
About once a second, on the shell's `wait` and `clock`, it reads the store as `foedrum status` does, folded afresh: never a lease, never git, never the state branch, so the kept branches' lines (ADR 0092) are not on the board. It writes nothing. It ends on Ctrl+C or a stop, with exit code 0, and leaves the last board on screen followed by a line feed.

### The board
- A first line: `<n> live batches` (`1 live batch`, `No live batches.` when none).
- One row per live batch, in the order they were ordered: a batch in Ordered, Brewing, Conditioning or Stuck. On Tap and Cancelled batches are left out. A row is `foedrum status`'s row (its id, order, lane, detail and summed receipt) led by the batch's time, counted from `orderedAt` as ADR 0179 counts it; a batch with no `orderedAt` shows `-` there.
- Under a Brewing batch, one indented line per running attempt, in the order its row names them: the step and attempt and the time since this board first saw it running (`  implement #1 / 1m 03s`), counted as `brew` counts `seenAt`. No turn and no tool: the store has neither.
- Every line follows ADR 0174's text rules: ASCII only, each code point outside U+0020 to U+007E shown as a `\uXXXX` escape, so model-written text in a row (a blocked summary, a last reason) cannot act on the terminal; then cut to the terminal's width less one. No colour.
- The board is at most the terminal's height less one line. When the rows do not fit, the last line that fits says `and <k> more batches`, and the attempts' lines go before any batch's row does.

### Drawing it
- The first board is written as lines. To redraw, the cursor goes back up to the board's first line (`moveCursor(0, -(lines - 1))`, then `cursorTo(0)`), and each line is written over the old one followed by `clearLine(1)` (ADR 0179), with a line feed between lines; after the last line, `clearScreenDown()` removes what was left of a longer board. The board is never blank on screen between two frames.
- It is redrawn about once a second and again when the terminal is resized. Only Node's `tty.WriteStream` calls; no escape sequence is written by hand.

## Consequences
- One terminal shows every live batch of a Brewery and keeps itself current, while `serve` and several `brew`s work.
- The board reads the whole store once a second. A Brewery's log is small (a batch is a few hundred events), so the fold costs milliseconds; a large one would make the watch slower, not the drivers.
- A running attempt's turn and last tool are on `brew`'s line only. Putting them on the board needs the driver to record them in the store: its own issue when wanted.
- The plain `foedrum status` is unchanged, byte for byte.

## Alternatives considered
- **A board in `serve`:** rejected on #442. `serve` is one driver among several (ADR 0044, ADR 0123), and a board belongs to the reader, not to one driver.
- **Record each running attempt's progress in the store for the board:** deferred by the maintainer. A write every few seconds per attempt, a schema and its retention, for a view.
- **Clear the screen and write the board again:** rejected. The blank frame between the clear and the write flickers on a Windows console (ADR 0179).
- **Print the board as new lines every second, without redrawing:** rejected. It scrolls the terminal and reads as a log; `status` in a loop already does that.
