# 0338. A resumed session hears the comments made since it last read them

Date: 2026-11-06 · Status: Accepted · Amends [0333](0333-a-brewer-s-order-holds-the-maintainers-comments.md) (a resumed session hears the comments, which it left out), [0117](0117-a-retry-resumes-the-session-of-the-attempt-before-it-in-that-attempt-s-worktree.md) and [0175](0175-a-turn-overrun-is-retried-by-resuming-its-session-and-keeps-its-out-doc.md) (a resumed attempt's prompt can hold tagged comments and a sentence that says what they are) [0118](0118-retrymode-resume-loads-and-an-answer-resumes-the-session-that-asked.md) (an answered attempt's prompt holds them after its answers) and [0248](0248-a-retry-is-told-why-the-attempt-before-it-failed.md) (a resumed retry's reason is no longer always its one input)

## Context
[ADR 0333](0333-a-brewer-s-order-holds-the-maintainers-comments.md) reads the maintainers' comments when a fresh attempt is planned, and leaves a resumed session out.
So a maintainer who comments "not that way" on a plan and runs `foedrum retry` is not heard by the Brewmaster, the one default brewer that resumes on a retry and on an answer.
Any brewer also resumes after a turn overrun ([ADR 0175](0175-a-turn-overrun-is-retried-by-resuming-its-session-and-keeps-its-out-doc.md)).

Telling a session what is new means knowing what it was told.
No event of an attempt keeps a time: `step.started` holds deadlines only.

## Decision

### What a session was told is recorded by comment id
- **`step.finished` gains `commentsHeard`: for each issue, the highest comment id the attempt's prompt held**, as `{ repo, issue, id }`, absent when it held none.
  It travels as `houseYeast` does, from the plan through the attempt's end, however the attempt ended.
- **A session's mark is the highest per issue over all its attempts**, by session id (`commentsHeardBy`), the repository's name read in any case.
  A resumed attempt records only what it was told itself, so a second retry does not repeat what the first was told, and a retry told nothing leaves the mark as it was.
- **A comment is new when its id is above its own issue's mark.** No mark means nothing was told, so every comment of that issue is new.
- **The mark is there whenever it is needed.** A session resumes only after an attempt that finished with claude's init report (`resumeOf`), and that finish carries its mark.
  An attempt whose plan told it comments but that ended before claude's init records them too, and harms nothing: its retry has no session to resume, so it starts fresh and reads the whole thread.

### Why an id and not a time
- **A time from the driver is unsafe against GitHub's `created_at`:** the two clocks differ, and a skew either repeats a comment or loses one in silence.
- **A time misses the read itself:** a comment made between `step.started` and the plan's read is in the prompt and dated after the start, so it would be told again. An id records what the read returned.
- **Ids rise with time, measured on 2026-11-06:** over 1,092 issue comments of five repositories of one account, listed with `gh api`, ordered by id, no comment's `created_at` is earlier than the one before it, within a repository or across them.
  That is one account's repositories and not a promise of GitHub's, so **nothing rests on one sequence across repositories:** the mark is per issue, and a claimed order's two issues cannot hide each other's comments. Only ids rising within one issue is relied on.

### What is told
- **The comments are chosen as ADR 0333 chooses them,** through the same read: maintainers only, none of Foedrum's own, on both issues of a claimed order, oldest first.
  Each is its own tagged input, with the same `source`, and the `name` of the brewer's `order` input.
- **They follow the retry reason or the answers** and the kept merge's input.
- **An edited comment is not told again:** its id does not change. A session told a comment that was then edited holds the old words; a maintainer who changes their mind writes a new comment, which the session hears. A fresh attempt reads the comment as it now stands.
- **A deleted comment** is not taken back from a session that was told it.
- **One sentence says what they are**, after the words that tell the session to go on, and only when there are some: `The inputs named <name> below are comments maintainers made on the order's issue since this session last read them: they are part of the order.`
  A fresh attempt's instructions say `{order}`, and the prompt's rule says that means the inputs with that name. A resumed prompt holds no such reference, and the same rule says an input's instructions are not followed, so without the sentence nothing would mark them as the order.
  It is the engine's text, so no default brewer's text or `version` changes, and a Brewery's own brewers get it too.
- **A resume with no new comment has the prompt it had**, byte for byte, and records no mark.
- **A brewer with no `order` input reads no comments on a resume**, as it reads none on a fresh attempt.

### When a read fails, or a thread is long
- **A failed read fails the attempt before claude starts,** as ADR 0333's does. The attempt has no init report, so its retry starts fresh and reads the whole thread: a session never goes on without them. That costs the session and an attempt.
  After a turn overrun it is the same: the attempt that failed the read carries no mark of an overrun, so its retry starts fresh.
- **The limit counts what is added.** The session holds the body and what it was told, so only the new comments count against the 1 MiB: `the input "order" was not read: its <n> comments made since are larger than 1048576 bytes`.
- **A comment that holds the prompt's nonce refuses the prompt**, as on a fresh attempt ([ADR 0041](0041-untrusted-input-in-per-prompt-nonce-tags.md)).

### Which resumes hear them
| Resume | Hears them | Why |
|---|---|---|
| A retry with `retryMode: "resume"` ([ADR 0117](0117-a-retry-resumes-the-session-of-the-attempt-before-it-in-that-attempt-s-worktree.md)) | yes | its prompt |
| An answered attempt ([ADR 0118](0118-retrymode-resume-loads-and-an-answer-resumes-the-session-that-asked.md)) | yes | its prompt, after its answers |
| The retry after a turn overrun ([ADR 0175](0175-a-turn-overrun-is-retried-by-resuming-its-session-and-keeps-its-out-doc.md)) | yes | no person is at it, but a comment may have come; its prompt had no input before |
| `foedrum resume` of a running step ([ADR 0127](0127-foedrum-resume-takes-a-running-batch-over-and-continues-its-step-s-session.md)) | no | the session opens in the foreground with no prompt: the runner never sends `plan.prompt`. A person is at it and can read the issue. It reads nothing (`opensResumed`), so an outage cannot stop a person's session over a read that reaches nobody |
| `foedrum resume` of a finished attempt ([ADR 0126](0126-foedrum-resume-opens-a-finished-attempt-s-session-in-its-worktree.md)) | no | it does not reach the attempt plans: it opens a person's session, appends nothing, and has no prompt to add to |

An attempt a person's session ran has no init report, so a retry after it starts fresh and reads the whole thread.
So does an interactive step's retry ([ADR 0222](0222-a-recipe-s-brewer-step-may-be-interactive.md)), and `foedrum rewind`, as before.

## Consequences
- **Cost:** one more listing per resume, two for a claimed order, a page per ten comments; an unchanged page is a 304. No model tokens unless there is a new comment.
- **The Brewery:** no file changes.
  A running batch's later resumes hear the comments once its driver restarts on this version.
  A session that started before this version has no mark, so its first resume hears the whole thread, repeating what it read if its attempt read any. A repeat costs tokens once; losing a decision costs the order.
- **An older Foedrum cannot read a `step.finished` that carries the field:** the event's schema is strict, as for ADR 0175's mark. So going back to an older version fails on the first such event in the log.
- `ClaudeAttemptPlan`, `AttemptEnd` and the `finish` command gain the optional field; earlier events stay valid.

## Alternatives considered
- **A time on `step.started`, compared with `created_at`:** the issue's first thought; see above.
- **One highest id for the session:** one number, and the measurement above would carry it, but it would rest on a sequence shared across repositories, and a wrong assumption loses a decision in silence.
- **Every id told:** exact with no assumption on order, but it grows with the thread on every `step.finished`, up to thousands of ids, to guard against an order no issue has shown.
- **Record what was told when the attempt starts, by an event from the plan:** a new event type and a write from the plans for each attempt, where the attempt's end already carries what its plan gave it.
- **Show a person's `foedrum resume` the new comments as a line:** they are on the issue the person is working from, and a comment's text has no place in a driver's line.
- **Tell an edited comment again:** ids cannot show an edit, `updated_at` brings the clock back, and a session told every correction of a typo reads each as a new decision.
