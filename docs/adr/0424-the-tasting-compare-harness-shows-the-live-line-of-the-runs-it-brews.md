# 0424. The tasting-compare harness shows the live line of the runs it brews

Date: 2026-11-19 · Status: Accepted · Amends [0174](0174-foedrum-brew-keeps-a-live-line-on-a-terminal.md) (its scope: `brew` only)

## Context
A Flight and `scripts/tasting-compare.ts` brew each run through `scripts/tasting-compare/harness.ts`, which calls `runBrew` as `foedrum brew` does but gave it no terminal. In between its start and end lines it was silent, for minutes per order (#1156).

## Decision
- Every run the harness brews shows the live line of ADR 0174, drawn by the same `liveTerminal` (`src/cli/live-terminal.ts`) under the same rule: standard output is a TTY, `TERM` is not `dumb` and `CI` is not set. Otherwise the harness prints what it printed before.
- The harness's own lines (the start, name and end lines, a brewer's `--model` line, the table) and `runBrew`'s lasting lines go through the live terminal's `print`, so none overwrites the live line. The live line is cleared before the harness exits on a stop and before the table.
- The start and end lines stay.

## Consequences
- ADR 0174's scope is `brew` and the comparison harness; `foedrum serve` keeps its plain lines.
- There is no second progress display: the rule, the line and its escaping stay in one place.
