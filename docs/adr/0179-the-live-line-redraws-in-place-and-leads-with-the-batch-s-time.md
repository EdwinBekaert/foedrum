# 0179. The live line redraws in place and leads with the batch's time

Date: 2026-10-25 · Status: Accepted · Amends [0174](0174-foedrum-brew-keeps-a-live-line-on-a-terminal.md) (the order of a redraw's calls, and the batch's time leading the line) and [0032](0032-routing-deadline-for-ordered-batches.md) (`batch.ordered` also records when it was ordered)

## Context
ADR 0174 redraws `foedrum brew`'s live line about once a second with `cursorTo(0)`, `clearLine(0)`, then the new text. Between the clear and the write the line is blank, and on a Windows console that blank frame shows: the line flickers (the fifth brew, batch 10-1, its first live run; #478).

The line's time is each attempt's own, from when `brew` first saw it run (`seenAt`), so it starts again at each step, and nothing on the line says how long the batch has been brewing. The events carry no wall-clock time to count it from: `batch.ordered` holds `routeBy`, a deadline, not when it was ordered.

## Decision

### A redraw writes over the old line
- A redraw is `cursorTo(0)`, the new text, then `clearLine(1)`, which clears from the cursor to the line's end. The new text overwrites the old one in place, and what was past the end of a longer old line goes. The line is never blank on screen between two frames.
- Clearing the live line before a lasting line and before every exit stays as ADR 0174 has it: `cursorTo(0)`, `clearLine(0)`.
- Still only Node's `tty.WriteStream` calls; no escape sequence is written by hand.

### The batch's time leads the line
- After the spinner and before the attempts comes the batch's time, joined to the first attempt by ` / ` and written as the attempts' times are: `| 4m 12s / implement #1 / 1m 3s / turn 14 / Edit src/checks/red-proof.ts`.
- It counts from when the batch was ordered, so it keeps counting across a stopped and restarted `brew`, a takeover and a retry. A batch ordered before this change has no such time: its time counts from the start of this `brew` run. A time before the order (a clock set back) shows as `0s`.
- The cut to the terminal's width less one stays a cut from the end, so the spinner and the batch's time stay on the line and the attempts' last parts go first.
- Only the live line shows it. The plain lines off a terminal are byte for byte what they were.

### `batch.ordered` records when it was ordered
- `batch.ordered` gains an optional `at`, the time the engine ordered the batch: `decide`'s `now`, the clock that already sets `routeBy`, on both commands that append it (`order`, the intake's and `foedrum brew`'s, and `order_again`, `foedrum order`'s).
- It is optional so that the events from before this change still read; every new `batch.ordered` has it.
- The fold keeps it on the batch as `orderedAt`, absent when the event has none.

## Consequences
- On a Windows console the line no longer flickers, and its first part says how long the batch has brewed, through every step.
- `batch.ordered`'s JSON Schema gains `at`. An older Foedrum, whose event schema is strict, cannot read a new `batch.ordered` from a pushed state branch; the state branch is read by the same version that writes it.
- The fallback for an old batch makes its time start again at each `brew` run until the batch ends; there are few such batches, and none outside a Brewery that brewed before this change.

## Alternatives considered
- **Write the new text, then pad it with spaces to the old line's length:** rejected. It needs the old line's length kept by the terminal, and `clearLine(1)` says the same through Node.
- **The batch's time from the first `step.started`:** rejected. Events carry no wall-clock time there either, and the time a batch waits to be routed or in Conditioning is part of how long it has brewed.
- **The batch's time from the state branch's commit times:** rejected. A commit is made at a flush, not at the order, and reading it needs git on the line's path.
- **The batch's time at the end of the line:** rejected. The cut to the width would take it first, and it is the one part that does not change with each step.
