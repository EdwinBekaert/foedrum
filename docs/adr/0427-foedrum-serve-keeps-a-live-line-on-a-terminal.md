# 0427. `foedrum serve` keeps a live line on a terminal

Date: 2026-11-26 · Status: Accepted · Supersedes [0174](0174-foedrum-brew-keeps-a-live-line-on-a-terminal.md) (its scope: `brew` only, and the rejection of the same line in `serve`), [0346](0346-the-live-line-runs-from-a-brew-s-first-second-to-its-last-with-gh-s-moving-mark.md) (that `serve` passes no `doing` report, touches no terminal and rejects a live line, and its still-running line where a live line is drawn) and [0424](0424-the-tasting-compare-harness-shows-the-live-line-of-the-runs-it-brews.md) (its consequence that `foedrum serve` keeps its plain lines)

## Context
`foedrum serve` printed `foedrum serve: still running for <brewery>` once a minute while it ran the steps of two batches for an hour, and nothing on the terminal moved (#1172). ADR 0174, ADR 0346 and ADR 0424 kept `serve` without a live line because a service's output is mostly read as a log. The maintainer watches `serve` on a terminal and wants a moving line there.

## Decision
- The live line's building (the parts of an attempt, the fitting to the terminal, the mark's timer, the redraws and the lasting line printed over it) is one module, `src/cli/live-line.ts`, which `brew` and `serve` both use. The comparison harness, `mash` and `lauter` draw it through `runBrew`.
- On a terminal, by the rule of ADR 0174 (standard output is a TTY, `TERM` is not `dumb` and `CI` is not set), `serve` keeps the live line from its start to its stop. It shows one part for each batch the driver holds that brews, each part as `brew` draws a batch (the batch's time of ADR 0326, then its attempts), the parts joined by ` ; `. The parts give up their last words together before any is cut, as the attempts side by side do in ADR 0346. A part counts from its batch's order, and from `serve`'s start for a batch that recorded none.
- With no batch to drive, the line says `waiting for work`.
- The line is redrawn about each second, also while a tick takes time, and the mark turns on its own timer, as in `brew`. `serve` still passes no `doing` report to its driver.
- Every lasting line of `serve`, the state branch's too, goes over the live line, and the live line is cleared before the last line `foedrum serve: stopped`.
- `foedrum serve: still running for <brewery>` is printed, after 60 s with no line of its own, only where no live line is drawn.

## Consequences
- A log that captures `serve`'s output off a terminal sees what it saw before.
- ADR 0174's scope is `brew`, `serve` and the comparison harness.
- There is no second progress display: the rule, the line and its escaping stay in one place.
