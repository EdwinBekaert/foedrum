# 0248. A retry is told why the attempt before it failed

Date: 2026-10-28 · Status: Accepted · Amends [0117](0117-a-retry-resumes-the-session-of-the-attempt-before-it-in-that-attempt-s-worktree.md) (a resumed retry gets one input) and [0118](0118-retrymode-resume-loads-and-an-answer-resumes-the-session-that-asked.md) (a resumed retry after an answered round gets it too)

## Context
A retry of a failed attempt starts fresh, with its brewer's inputs, or resumes the session before it ([ADR 0117](0117-a-retry-resumes-the-session-of-the-attempt-before-it-in-that-attempt-s-worktree.md)).
Neither is told why the attempt before failed: a resumed one reads only "The run before this one ended before the step was done" (`goOn`), and a fresh one nothing at all.
Only a retry after the secret scan is told why ([ADR 0187](0187-a-committing-brewer-s-attempt-is-scanned-for-secrets-when-it-ends-done.md)).
The engine knows the reason, and often only the engine does: an out doc refused by its schema fails the attempt with zod's path (`subOrders.1.doneWhen: Required`, [ADR 0233](0233-a-plan-is-an-out-doc-whose-paths-the-engine-checks-shown-as-one-comment-per-order.md)), a plan's missing path by the `touches` check, a `done` with no commit by the runner.
The brewer that wrote the out doc saw it as valid, so a resumed session retries the same mistake, and a fresh one may.
The Brewmaster of #586 is the first default brewer to resume its session on a retry ([ADR 0234](0234-the-brewmaster-writes-a-plan-on-the-planner-alias-and-mash-runs-it.md)).

## Decision
- **A retry after a failed attempt gets that attempt's reason as an input** (source `retry`, described as `why step <id> runs again: the failure of <id>#<n>`): "The attempt before this one, `<id>#<n>`, failed: …".
  The reason is the engine's text, but it can quote what a brewer wrote, so it goes in as tagged, untrusted data ([ADR 0041](0041-untrusted-input-in-per-prompt-nonce-tags.md)), left out for a fixed line when it looks like a secret ([ADR 0088](0088-out-doc-text-that-looks-like-a-secret-is-left-out-of-the-pull-request-and-the-status-comment.md)), and held to a route input's bound, 64 KiB.
- **A fresh retry** gets it last, after its other inputs, where a scan retry gets its own.
- **A resumed retry** gets it as its one input, after the instruction to go on; a resumed retry after an answered round gets it too, and still no answers, which its session holds ([ADR 0118](0118-retrymode-resume-loads-and-an-answer-resumes-the-session-that-asked.md)).
- **Not** a retry after the secret scan, which keeps its own input (ADR 0187); a retry after a turn overrun, which keeps its own instruction to finish ([ADR 0175](0175-a-turn-overrun-is-retried-by-resuming-its-session-and-keeps-its-out-doc.md)); an attempt after an answer or a route, which no `retry: true` schedules.
  A person's `foedrum retry` of a Stuck batch schedules `retry: true`, so it gets the reason too.
- Decided by the consultant, 2026-10-28.

Rejected: resumed retries only (a fresh retry of an invalid out doc would stay as blind); the reason in the engine's instruction text instead of an input (it can carry a brewer's words, which only tagged inputs may); the brewer's prompt telling it to check its out doc again on a retry (it cannot see the path zod named).

## Consequences
- Every default brewer's retry reads why the attempt before it failed: a few lines of the engine's text, at most 64 KiB.
- A resumed retry's prompt is no longer the instruction alone: it holds one tagged input.
- No new event: the reason is already on the failed attempt's `step.finished`.
