# 0428. A failed check, a Stuck batch and the watch board say what happened and what follows in plain words

Date: 2026-11-27 · Status: Accepted · Amends [0340](0340-a-brewer-s-handover-is-kept-as-a-proposal-and-reaches-no-later-prompt.md) (the status comment's handover line), [0386](0386-findings-times-and-step-lines-read-in-plain-words.md) (the times of the status comment, and the relative part the terminal adds), [0274](0274-the-red-proof-reads-line-coverage-of-the-change-and-a-test-map-not-test-names.md) (how a failed check names its lines, and how the files outside every code area are shown), [0325](0325-a-step-counts-its-attempts-per-round.md) (the count a Stuck line shows), [0179](0179-the-live-line-redraws-in-place-and-leads-with-the-batch-s-time.md) and [0188](0188-foedrum-status-watch-redraws-a-board-of-the-live-batches.md) (the board's rows, which no longer lead with the batch's time)

## Context
Six lines of the status comment and of `foedrum status --watch` read as the engine's words, not a person's (#1173; found on Brewery issues #26, #27 and #28 on 2026-11-19):
- A failed check named every changed line with its whole path, `scripts/tasting-compare/harness.ts:158, scripts/tasting-compare/harness.ts:159, …`, ten of them and a count of the rest, and the status comment cut the line.
  The line under it, `outside every code area: …`, read as part of the failure, though ADR 0274 says such files never fail the check.
- A Stuck batch said `green used its 1 attempt` while green ran twice (the count is the current round's, ADR 0325), said nothing of the checks that passed, and offered its options as bare words, `retry, skip, recipe, rewind, cancel`, when the batch is called by its issue number.
- The handover line, `2 handover lines: foedrum handover 27`, did not say what a handover is.
- A time read `since 2026-11-19T13:11:21.291Z`, which ADR 0386 left out of its UTC-minute rule.
- The watch board started each row with the batch's age (`203m 11s`, read as time worked) and its ids, so on a 68-column terminal the step and the reason were cut.

## Decision
- **A failed check names each file once, with its ranges.**
  `36 changed lines no test runs, all in scripts/tasting-compare/harness.ts: lines 158–159, 249–256, 300` for one file; `5 changed lines no test runs: src/a.ts: lines 1–2; src/b.ts: line 4; src/c.ts: lines 9, 11` for several, in the order of the change's files.
  Lines in a row are one range, and a line whose branch is not taken stands apart from the range beside it, with its note: `lines 5, 6 (branch not taken), 7`.
  Every line is named: a count of the rest is gone, since ranges keep the reason short.
- **The status comment says what follows a failed check from the route the engine took.**
  Under the step's line: `next: a round back to \`implement\``, when the next attempt on the batch's path was scheduled from the failed step by a route, and `next: the batch is Stuck here` under the step a Stuck batch stopped at.
  Never from the words of the check's stored reason, and nothing before the engine has taken a route.
- **The files outside every code area are information.**
  `for information, changed files outside every code area (they never fail the check): docs/adr/…` stands under the step's line, after what follows a failure.
- **A Stuck batch says how often the step ran, what passed, and what each option does.**
  - `\`green\` ran 2 times in all and has no attempt left; the last: …` counts every attempt of the step in the batch's life, not the round's count the event keeps (`attempts_exhausted.attempts` stays as ADR 0325 has it; the comment reads the step's attempts).
  - A line under it, `Passed: the check "lint", the check "typecheck"`, lists the checks of the step's latest attempt that exited with code 0 and none that was skipped.
  - The `Next:` line gives each option its whole command, whatever number the batch is called by, and what it does: `` `foedrum retry 7` (give the step another attempt) ``; `recipe` and `rewind` show what they take, `<recipe> "<reason>"` and `<step> <owner/name>=<commit>`, as `foedrum --help` writes them.
- **The handover line says what a handover is.**
  `2 notes the brewers left (proposals, not used by this batch): read them with \`foedrum handover 27\``, and for one, `1 note the brewers left (a proposal, not used by this batch): read it with …`.
  `foedrum handover`'s own head keeps `N handover lines a model wrote, to read as data.`
- **The status comment's times are the UTC minute, with no relative part.**
  A passed deadline, a routing deadline, `stalled … since`, `failing … since`, the Failing mark and `waits for its checks … since` read `2026-11-19 13:11 UTC`, so the comment is not edited every minute.
  The terminal adds how long ago: `foedrum status` and the board write `since 2026-11-19 13:11 UTC (4 min)` after the time a thing began (`failing … since`, `stalled … since`), counted from the terminal's clock, in minutes up to an hour, then hours and the minutes left, then days and the hours left.
  A time that is ahead of the clock, such as a reminder, has no age.
- **The watch board leads with the step and what it waits for.**
  A row reads `state  detail  id  order  age 1m 23s`: the state and what the batch does or waits for come first, then the batch's id and order, and the age last, worded as an age.
  The attempts' lines under a row stay.

## Consequences
- A person reads where a check's lines are without a path a dozen times, and sees at once whether a round follows or the batch waits for them.
- A Stuck line's `ran 2 times in all` counts the step's attempts in the batch's life, which the round's count never said; the event is unchanged, so no ledger changes.
- The status comment's times no longer change from minute to minute, and a time lost its seconds.
- On a narrow terminal the board cuts the ids and the age, not the step and the reason.
- A Brewery's saved status comments keep their old words until the next edit.
- **Brewery migration:** none; Foedrum has no release.
