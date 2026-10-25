# 0189. The status board outlasts a failed read and counts rewrapped rows

Date: 2026-10-25 · Status: Accepted · Amends [0188](0188-foedrum-status-watch-redraws-a-board-of-the-live-batches.md) (what the board does when a read fails, on a terminal of two rows, and how far a redraw goes back up)

## Context
ADR 0188 has `foedrum status --watch` read the store about once a second until Ctrl+C or a stop. Its first implementation (#499) let a read that throws end the watch, and a read that throws from the resize handler went uncaught: a store busy while a driver writes, or an event this binary does not know, ended a view that is meant to run until the user stops it.

ADR 0188 has a redraw go back up `lines - 1` rows. Windows Terminal, conhost (by default), macOS Terminal and iTerm2, VTE terminals and tmux rewrap the lines on screen when the window gets narrower, so after such a resize the old board takes more screen rows than it has lines, and going up by its lines left its top above the new board.

ADR 0188 keeps the board to the terminal's height less one line, but on a terminal of two rows its `and <k> more batches` line made the board two lines.

The review of #499 found all three.

## Decision
- A read of the store that fails ends nothing. The last board drawn from a store that read stays on screen, cut where it must be so that it and one more line fit in the height less one, and that line says `could not read the store: <why>; trying again each second`, under ADR 0174's text rules. The next board, a second later or on a resize, reads again; only Ctrl+C or a stop ends the watch.
- A redraw goes back up by the screen rows the old board takes at the width now: each old line counts `ceil(length / columns)` rows, at least one, and one when the width is unknown. Then `moveCursor(0, -(rows - 1))` and `cursorTo(0)`, as ADR 0188 has it with lines.
- On a terminal of two rows the board is its first line only.
- An attempt's time reads as `brew`'s does (ADR 0179): `  implement #1 / 1m 3s`, where ADR 0188 wrote `1m 03s`.

## Consequences
- A watch left open through a busy store or a newer event says so and carries on, and comes back by itself once the store reads.
- A terminal that does not rewrap on a resize (xterm, conhost with its wrap setting off) gets a redraw that goes up too far after a narrowing resize, over lines above the board, once per such resize; the terminals above, the defaults on each system, get a clean board.

## Alternatives considered
- **End the watch with one line on a failed read:** rejected. A busy store passes in a moment, and a view meant to run until Ctrl+C should outlast it.
- **Clear from the top of the screen after a resize:** rejected. It also clears lines above the board that are not the board's.
