# 0453. A line with a braille mark is cut to the width less two

Date: 2026-11-27 · Status: Accepted · Amends [0346](0346-the-live-line-runs-from-a-brew-s-first-second-to-its-last-with-gh-s-moving-mark.md) (a braille frame is one column wide)

## Context
On 2026-11-27 `foedrum serve` ran three batches in Windows Terminal, whose fonts hold no braille, so it draws the mark from a fallback font. Every redraw of the live line landed on a new row: the pane filled with copies of the line, eight a second, and the batches could not be read from it.
Each row held one whole line, cut to the width less one, and the next line started on the next row. ADR 0346 counts a braille frame as one column. Drawn two columns wide, it makes the line as wide as the terminal, the cursor wraps to the next row, and `cursorTo(0)` goes back to the start of that row, not of the line.

## Decision
- On a terminal whose marks are braille, the live line is fitted to the width less one before ADR 0346's mark goes in, so the whole line is cut to the width less two. A terminal on the ASCII marks keeps the cut to the width less one.
- `room` in `src/cli/live-line.ts` decides, from the terminal's marks: any that is not ASCII takes the extra column. Nothing asks the terminal how wide a frame is drawn, since no console reports it.

## Consequences
- A braille line shows one character less at its end. Nothing else changes: the frames, their timer and the redraw stay as ADR 0346 has them.
- `foedrum status --watch` draws no mark and keeps its cut.
- **Migration:** none. Nothing here is read from a Brewery's files or recorded in the events.

## Alternatives considered
- **The ASCII marks on Windows:** rejected. The maintainer asked for `gh`'s mark, and the wrap comes from the width, not from the frames.
- **A carriage return in place of `cursorTo(0)`:** rejected. Both go back to the start of the row the cursor is on, so neither undoes a wrap.
