# 0118. retryMode resume loads, and an answer resumes the session that asked

Date: 2026-10-22 · Status: Accepted · Amends [0059](0059-attempt-plans-from-the-brewer-of-the-step.md) (`retryMode: resume` leaves the list of what a brewer may not ask for, and an answer reaches a resuming brewer in its session instead of the `answers` input), [0117](0117-a-retry-resumes-the-session-of-the-attempt-before-it-in-that-attempt-s-worktree.md) (an answered attempt resumes too, and `foedrum serve` and `foedrum brew` say which brewers resume) and [0078](0078-the-red-proof-reads-the-test-report-and-testsunchanged-compares-lines.md) (the red proof and the testsUnchanged guard read the worktree a resumed attempt ran in)

## Context
[ADR 0117](0117-a-retry-resumes-the-session-of-the-attempt-before-it-in-that-attempt-s-worktree.md) plans and starts a resumed attempt: `claude --resume <id>` in the worktree of the attempt whose session it continues, recreated under its own lease, with no worktree of its own. It left three things for #327, part 4 of #169:

- the loader still refused a brewer with `"retryMode": "resume"` by name ([ADR 0059](0059-attempt-plans-from-the-brewer-of-the-step.md)), and no driver outside the tests was told which brewers resume;
- an `answer` to `needs_input` always scheduled a fresh attempt with the answers as a tagged input, ADR 0059's stand-in for [ADR 0006](0006-no-mid-run-questions.md)'s "`--resume` with the answers when the session was kept";
- the red proof's commits and the testsUnchanged guard ([ADR 0078](0078-the-red-proof-reads-the-test-report-and-testsunchanged-compares-lines.md)) read an attempt's own worktree and branch, which a resumed attempt does not have: the guard let a resumed attempt through unread, and the red proof read the branch of an attempt that made none.

`foedrum serve` and `foedrum brew` already handed the driver the real worktree manager, whose `recreate` the driver uses, but their shell's type did not name it, so nothing said a driver on the real machine can resume.

## Decision

### Loading
- **`retryMode: resume` loads.** Its line leaves ADR 0059's list; `foedrum doctor`, which shows the loader's lines, stops naming it.
- **The driver asks the brewer.** `serve` and `brew` (`wireDriver`) give `openDriver` `resumes(attempt)`: true when the brewer of the attempt's step in its batch's recipe has `retryMode: resume`. Their shell's `worktrees` gives the manager with `recreate`, so a resumed attempt gets its worktree back instead of always falling back.

### An answer resumes the session that asked
- **The answer marks its attempt.** `decide` schedules the attempt an `answer` starts with `answered: true` on `step.scheduled`, as a retry has `retry: true`. A `rewind` or a `recipe` back to a step whose last attempt asked is no answer and starts fresh, which is why the mark is on the event rather than read from the attempt before it (ADR 0117's first alternative).
- **It resumes on the rules of a retry.** `resumeOf` takes an answered attempt as it takes a retry: it resumes the session of the attempt before it when that attempt finished with claude's init report, did not succeed, and an attempt of its session has a worktree to recreate. `needs_input` is no success, so an attempt that asked resumes.
- **Its prompt carries this round's answers.** The short prompt says `A human answered the questions the run before this one asked. Go on with the step where it stopped, with the answers below, then write <out doc> as your instructions say.`, then the `answers` input between the nonce tags ([ADR 0041](0041-untrusted-input-in-per-prompt-nonce-tags.md)), with this round's answers only: the session holds the earlier rounds, as the input of a fresh attempt or the prompt of a resumed one.
- **The fallback is today's attempt.** When the session or its worktree cannot be got back (ADR 0117's fallbacks), the answered attempt starts fresh with the brewer's inputs and every round's answers, as before. When claude cannot find the session, the resumed run fails retryably (ADR 0117), and its retry starts fresh with every round's answers: an attempt with no init report has no session to resume.

### The guards read where a resumed attempt ran
- **testsUnchanged** reads a resumed attempt's changes from the start commit of the worktree it ran in to the branch of the attempt that made it (`ranIn`), so the changes of every attempt of that session count, the failed ones before it included.
- **The red proof** reads its `of` step's commits up to the branch of the worktree its latest success ran in: a resumed success committed on its maker's branch (ADR 0066's task tree of a resumed success).

## Consequences
- A Brewery's brewer may say `"retryMode": "resume"`: a retry after a crash, a cancel or a turn that ran out, and an answer to its questions, continue its own session in its own worktree, uncommitted work included.
- `step.scheduled` gains an optional field; earlier events stay valid, and an answered attempt of an earlier event starts fresh, as it did.
- A missing session costs an answered attempt one attempt of the step's `maxAttempts` before the fresh one, as it costs a retry (ADR 0117); with none left, the batch is Stuck as `attempts_exhausted`, and the answers are still in the log for a human's `retry`, which starts fresh with them.
- A brewer with `retryMode: fresh` sees no change: its answered attempt starts fresh with every round's answers.

## Alternatives considered
- **Give a resumed answered attempt every round's answers.** Harmless, but the session already holds the earlier ones, and repeating them reads as if the questions were asked again.
- **Infer an answered attempt from the attempt before it (`needs_input`).** No event, but a `rewind` or `recipe` back to that step would resume a session the human chose to leave.
- **Fall back within the same attempt when claude finds no session.** Refused by ADR 0117 for the same reasons: the recorded session would not be the one that ran.
