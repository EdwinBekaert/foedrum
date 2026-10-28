# 0175. A turn overrun is retried by resuming its session, and keeps its out doc

Date: 2026-10-25 · Status: Accepted · Amends [0028](0028-brewer-runner-outcomes-environment-and-test-first.md) and [0047](0047-the-claude-brewer-runner-its-stream-endings-and-progress.md) (a run past `maxTurns` whose session the driver can resume fails retryably, marked `overran`), [0118](0118-retrymode-resume-loads-and-an-answer-resumes-the-session-that-asked.md) (a resumed retry after a turn overrun keeps the out doc, or gets its copy back, instead of removing it), [0172](0172-an-attempt-s-receipt-from-its-stream.md) and [0181](0181-receipts-show-no-cost.md) (the receipt line of an attempt that resumed after an overrun ends with `resumed after the turn budget`) and [0117](0117-a-retry-resumes-the-session-of-the-attempt-before-it-in-that-attempt-s-worktree.md) (the retry of such a run resumes its session whatever the brewer's `retryMode`, with a prompt of its own, keeps the out doc the run wrote, and fails instead of starting fresh when the session cannot be got back)

## Context
A brewer's `maxTurns` goes to claude as `--max-turns`, so claude stops the session at the limit, wherever it is in its work.
[ADR 0047](0047-the-claude-brewer-runner-its-stream-endings-and-progress.md)'s ending table fails a run past `maxTurns` as not retryable: the same budget would run out again.
The step's other attempts go unused, and the batch is Stuck at once.

On the fourth brew (batch 9-1, #442), the Gauger had committed its failing tests and written `gauge.md` when it reached 89 turns against 80.
Going on took a person four commands and a typed prompt: `foedrum retry`, `foedrum resume`, "you ran out of turns, check gauge.md and end", then `foedrum brew` again.
The resumed session needed a few turns.
Its worktree had been recreated from the attempt's branch, so the uncommitted `gauge.md` was gone and had to be written again.

"The same budget would run out again" holds for a fresh attempt, not for one that continues the session: that one starts with the work done.
[ADR 0117](0117-a-retry-resumes-the-session-of-the-attempt-before-it-in-that-attempt-s-worktree.md) already resumes a retry's session when the brewer's `retryMode` is `resume`, but every default brewer starts fresh.

## Decision

### The overrun is retryable when its session can be resumed
- **A run past `maxTurns` fails retryably** when claude's init report was seen, so the session exists, and the driver can resume it: a claude step, not a check step, with a worktree manager that can recreate a worktree (`recreate`, which `foedrum serve` and `foedrum brew` have).
  The driver says the second through the attempt's limits (`resumable`); `settleAttempt` reads both in its one budget rule, so the order of [ADR 0047](0047-the-claude-brewer-runner-its-stream-endings-and-progress.md)'s table stays as it is.
- **Its outcome carries the mark `overran: "turns"`** on `step.finished`, beside `retryable: true`, so the retry knows why the attempt before it ended without reading its reason.
- **Otherwise it stays not retryable**, as before: a run with no init report, or a driver that cannot recreate a worktree, would start the retry fresh, and the same budget would run out again.

### Its retry resumes the session
- **The retry of a marked attempt resumes its session whatever the brewer's `retryMode` says.**
  The driver asks `resumeOf` as for any retry, so [ADR 0117](0117-a-retry-resumes-the-session-of-the-attempt-before-it-in-that-attempt-s-worktree.md)'s conditions decide, in one place: the attempt before it finished with claude's init report, did not succeed, and an attempt of its session has a worktree to recreate.
- **It does not fall back to a fresh attempt.**
  When `resumeOf` says fresh, or the worktree cannot be recreated, the retry fails at once as not retryable, `the turn budget ran out, and its session cannot be resumed: <why>`, with `resumeOf`'s or the recreate's why: a fresh attempt would meet the same budget.
  A human's `retry` from Stuck then starts fresh: the attempt before it carries no mark.
- **A resumed run that finds no session is the one exception.**
  It ends before claude's init and fails retryably, as [ADR 0117](0117-a-retry-resumes-the-session-of-the-attempt-before-it-in-that-attempt-s-worktree.md) says, without the mark.
  Its retry, if the step has one left, follows the brewer's `retryMode`, which for every default brewer starts fresh: there is no session left to resume, and a fresh run is the only way on.
- **Its prompt is its own**: `The run before this one ran out of turns. Finish what is left of the step, write <out doc> as your instructions say, and end.`, with no tagged input, as a resumed retry has none.
- **It gets the brewer's full `maxTurns` again**, as every attempt does: the budget is per run.
- **The status comment says it**: the step line of a running resumed attempt, and its receipt line, end with `resumed after the turn budget`.

### It keeps the out doc the run wrote
- **A resumed run after an overrun keeps the step's out doc in the worktree.**
  [ADR 0118](0118-retrymode-resume-loads-and-an-answer-resumes-the-session-that-asked.md) removes it before every other resume, so a run is read by what it writes; here the out doc is the work the session is told to finish.
- **When its worktree has to be recreated, the out doc comes back from a copy.**
  As an attempt ends on a retryable overrun with an out doc, the runner writes the text it read beside the attempt's settings file, `<attempt>.out.md` under `attempt-settings`, which the settings cleanup removes with its batch ([ADR 0183](0183-the-engine-s-fixed-rules-for-a-brewer-go-in-an-appended-system-prompt.md)).
  The retry's plan names that copy, and before claude resumes, the runner writes it into the worktree when the worktree has no out doc: a new file only, inside the worktree, through no link.
  A copy that cannot be written costs the attempt nothing: its retry resumes without it.
  Nor does an out doc whose folder the recreated worktree does not have, as when git does not track it: the session resumes without it.
  A copy that would be written outside the worktree, or cannot be read or written there, stops the attempt before claude starts, as an out doc that cannot be removed does ([ADR 0118](0118-retrymode-resume-loads-and-an-answer-resumes-the-session-that-asked.md)).
- **`foedrum resume`'s runner keeps it too**, amending [ADR 0127](0127-foedrum-resume-takes-a-running-batch-over-and-continues-its-step-s-session.md) (2026-10-28, #614): a takeover whose session continues a run that ended on its budget opens with that out doc, or its copy put back, as the headless runner's resumed run does.

## Consequences
- A brew whose brewer runs past `maxTurns` goes on by itself, within the step's `maxAttempts`, in the same session and worktree, out doc included.
- A brewer that runs past its budget every time costs the step's attempts instead of one: each resumed run gets the whole budget again, and the batch is Stuck as `attempts_exhausted` when none is left.
- An overrun after claude's init report on a driver that can resume no longer goes Stuck at once: a person's `foedrum retry` is needed only when the attempts are used.
- The mark is a new field of a failed outcome on `step.finished`; an event recorded before it still reads.
  An older Foedrum cannot read a `step.finished` that carries it: the outcome's schema is strict.
- `foedrum resume` of a finished attempt ([ADR 0126](0126-foedrum-resume-opens-a-finished-attempt-s-session-in-its-worktree.md)) is unchanged, and so is a takeover of a running batch ([ADR 0127](0127-foedrum-resume-takes-a-running-batch-over-and-continues-its-step-s-session.md)) whose session continues a run that has not ended on its budget: it removes the out doc before it as [ADR 0118](0118-retrymode-resume-loads-and-an-answer-resumes-the-session-that-asked.md) says.

## Alternatives considered
- **Make every overrun retryable and let `retryMode` decide.** Every default brewer would retry fresh into the same budget.
- **Start fresh when the session cannot be got back.** The same budget would run out again, at the cost of a whole run's tokens.
- **Raise `maxTurns` on the retry.** The resumed run starts with the work done, so the budget it needs is the brewer's own; a larger one only lets a looping brewer spend more.
- **Read the out doc back from the state branch** ([ADR 0103](0103-out-docs-reach-the-state-branch-through-the-store.md)). It is there only after a flush, and the attempt plans would need the state worktree; the copy beside the settings file is there as the attempt ends.
- **Commit the out doc in the attempt's branch.** The out doc is not the brewer's work, and a committing brewer's `done` would count it as a commit (ADR 0074).
