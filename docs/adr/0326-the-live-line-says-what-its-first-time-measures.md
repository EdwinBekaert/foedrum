# 0326. The live line says what its first time measures

Date: 2026-11-05 · Status: Accepted · Amends [0179](0179-the-live-line-redraws-in-place-and-leads-with-the-batch-s-time.md) (the batch's time on the live line is written with words that say what it measures)

## Context
ADR 0179 leads `foedrum brew`'s live line with the batch's time as a bare number. In the self-brew trial (#374) a person read `34m 22s` as how long the running step had run, when `gauge #1` had run for 53 seconds. The batch's age includes every earlier stop and wait.

## Decision
- The batch's time is written `ordered <time> ago` when it counts from the batch's recorded order time: `| ordered 34m 22s ago / gauge #1 / 53s / turn 12 / Edit test/integration/demo-la`.
- A batch with no recorded order time counts from this `brew` run's start (ADR 0179), and says so: `| brew started 2m 5s ago / gauge #1 / ...`. It never says `ordered` without an order time.
- A time before the order shows as `ordered 0s ago`, as ADR 0179's `0s`.
- The attempts' fields are as they were. The cut to the terminal's width less one stays a cut from the end, so the spinner and the batch's time with its words stay on the line, and the attempts' last parts go first.
- `foedrum status --watch`'s board is not changed.

## Consequences
- The line is 12 or 17 columns longer before its first attempt; on a narrow terminal the attempts' last parts are cut sooner.
- No migration: the words are drawn, not recorded.

## Alternatives considered
- **A shorter word (`age`, `batch`):** rejected. `ordered ... ago` says what the time counts from; a noun still leaves it to be guessed.
