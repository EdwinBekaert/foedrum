# 0228. A failed Actions job's log goes with the batch back to its fix step

Date: 2026-10-27 · Status: Accepted · Amends [0219](0219-a-failing-check-on-an-open-pull-request-sends-its-batch-back-to-a-fix-step.md) (what the route input of a pull-request route holds), [0213](0213-an-open-pull-request-s-checks-on-its-head-are-recorded-once-they-finish.md) (a finished record may carry an excerpt of a failed job's log) and [0073](0073-github-only-through-gh-s-own-login.md) (doctor's minimum gh, now 2.97.0)

## Context
Since [ADR 0219](0219-a-failing-check-on-an-open-pull-request-sends-its-batch-back-to-a-fix-step.md) a failing check on a brewed pull request's head sends the batch back to a fix step whose route input names each failed check, its conclusion and a link the brewer cannot open.
A failure that happens only in CI (one platform, a runner's tool version) is then fixed blind, and can use up its rounds and go Stuck (#559).

Six facts, probed with gh 2.102.0 on a failed job of Foedrum's own CI (2026-10-27), shaped it.
`GET /repos/{owner}/{repo}/actions/jobs/{job_id}/logs` answers a redirect to a signed blob URL that `gh api` follows; with `--include` it prints the blob's `200`, then the plain-text log, about a megabyte for a job that runs a test suite (1,055,206 bytes), whole: a `Range` header is ignored.
Since gh 2.97.0 (the fix of GHSA-3m3g-3wcr-px46) `gh api` refuses to print a body with terminal escape sequences, which an Actions log has, unless given `--allow-escape-sequences`: it prints the status line and headers, then exits 1, so the client would read a `200` with an empty body.
The end of a job's log is not its failure: after the failing step come the post-job steps (`Post job cleanup.`, the checkout's cleanup); the failing step is the `##[group]Run <command>` block before the first `##[error]` line, and every line starts with an ISO timestamp.
A check run whose app is `github-actions` has the job's id as its own `id`; a commit status, or another app's check run, has no Actions log.
The supervisor's tick reads the record the intake writes and may send the batch back as soon as it lands ([ADR 0219](0219-a-failing-check-on-an-open-pull-request-sends-its-batch-back-to-a-fix-step.md)); the attempt's plan is a pure function of the event log.
And a job's log is printed by code the pull request changed: untrusted text that may hold a secret, as a check's output may ([ADR 0069](0069-check-steps-run-the-repositorys-commands-in-an-attempt-of-their-own.md), [ADR 0088](0088-out-doc-text-that-looks-like-a-secret-is-left-out-of-the-pull-request-and-the-status-comment.md)).

## Decision

### When it is read
- **In the intake's pass, when a finished record with a failed check is about to be written** (`recordChecks`, `src/engine/pr-checks.ts`): after the unchanged record is skipped, so a record that does not change reads no log again.
- **For the first `MOST_FAILED_CHECKS` (5) failed checks that are Actions jobs** (`ReadCheck.job`, read from a check run's `id` when its `app.slug` is `github-actions`), one at a time, in the record's order.
- **For at most a minute per record** (`LOG_READS_MS`, measured on the pass's clock), well inside a pass's deadline of 150 s: once it is up, the failed jobs not read yet get `unread` and the record is written, so a record with slow logs never holds up the pass on every pass, and the next pass skips it as unchanged.
- **A read GitHub's rate limit holds is tried again**: the reader throws it, the pass reports it and writes no record of that head, and a later pass reads the logs after the pause; every other failed read is an answer, `unread`.
- The excerpt is in the same event the tick reads, so it never races the route back; a pass given up at its deadline after reading logs records nothing, as before.

### What is kept
- **On each such check, `log`: `{ excerpt }` or `{ unread }`** (`HeadCheck.log`, `src/schemas/events.ts`), never on a check that passed, a commit status, another app's check run, or a failed job past the first five.
- **The excerpt** (`jobLogExcerpt`, `src/checks/job-log.ts`): the log without a byte order mark, its escape sequences, every other control character but the tab, and each line's leading timestamp; the lines of the step that holds the first `##[error]` line, from its `##[group]Run` line up to and including that error; without an error line, the log up to `Post job cleanup.`; then lines that look like a secret left out, as a check's tail is (`withoutSecrets`, `src/checks/gravity.ts`), and cut to `MAX_TAIL_LENGTH` (4,000 characters) from its end (`tailOf`).
  It is filtered once, when recorded, and never again by its readers ([ADR 0209](0209-a-check-that-fails-on-an-open-pull-request-s-merged-tree-is-posted-on-it.md)).
- **`unread`** is one line why, at most 200 characters: a log longer than its limit, `404` (no log), `410` (expired), `403` (no access), any other status, an empty body, a read that failed (the error's first line, unless it looks like a secret, read by the reader), or the record's minute was up. The record is written all the same.
- `sameHeadChecks` still compares name, kind, conclusion and link only: a log never makes two records differ.

### How it is read
- **`githubCheckReader(reads, client).log(url, job)`** (`src/github/checks.ts`) asks `client.text`, a new method of the GitHub client: a `GET` through `gh api --include --allow-escape-sequences`, the answer kept as text and never parsed, with its own limit of 32 MiB for the answer and the process runner's output (ADR 0035); every other request is unchanged.
- **Not through the cached reads** ([ADR 0068](0068-the-intake-in-foedrum-serve-brewery-orders-and-routing-by-label.md)): a log is read once per record, and would fill the cache.
- **gh 2.97.0 or later**: doctor refuses an older gh (`MIN_GH`), which does not know the flag and is the one with the escape-sequence vulnerability.

### The route input
- **Under each failed check of `pullRequestRouteOf`** (`src/brewers/attempt-plan.ts`): `The end of its job's log, around its first error:` and the excerpt, or `Its job's log could not be read: <why>.`; a check with no `log` gets nothing more.
- It stays untrusted, in the nonce tags, the whole input held to 64 KiB (`bounded`, [ADR 0128](0128-an-attempt-a-route-schedules-gets-what-sent-it-back.md)): five excerpts of 4,000 characters fit.

### What this is not
- The status comment, the Stuck reason (`pull_request_failed`'s failed checks) and the merge brief keep the name, conclusion and link; no log reaches GitHub through them.
- A check on the merged tree already records its own tail ([ADR 0209](0209-a-check-that-fails-on-an-open-pull-request-s-merged-tree-is-posted-on-it.md)); #547's causes are unchanged.

## Consequences
- A brewed pull request that fails CI on one platform gets a fix round that reads the failing step of that platform's job.
- A failed record costs one request per failed Actions job, at most five, and the download of each log; an unchanged record costs none.
- A log that is gone, too long or unreadable leaves the route input as ADR 0219 had it, with one line saying why.
- A re-run that fails the same check the same way is the same record and keeps its first excerpt; a re-run that passes records no log.
- The event schema moves (`HeadCheck.log`): an older Foedrum cannot read a record that holds one.
- The excerpt is in the event log, which the state branch pushes: the secret filter is the second layer of [the row](../trust-boundaries.md) for a secret in what is pushed, as ADR 0209's is.
- Doctor asks for gh 2.97.0 or later, up from 2.26.0.

## Alternatives considered
- **Read the log when the fix attempt is planned**: the plan is pure, from the event log; a retry of the attempt would see another text, or none once the log expired.
- **A pass that runs out of time records nothing**, as before, without a budget for the logs: five reads of 30 s each reach the pass's deadline, and the same reads run again on every pass.
- **A rate-limited read recorded as `unread`**: the pause ends within the hour, and a record that does not change is never read again, so the fix would go without a log it could have had.
- **A separate event after the record**: the tick may send the batch back before it lands, and the fix starts without it.
- **The raw last 4,000 characters**: the post-job steps, as probed, never the failure.
- **The whole failing step**: unbounded; a test suite's step is most of the log.
- **`gh run view --log-failed`**: it downloads the zip of every job of the run, and has broken on changes of the log format.
- **A `Range` request for the end**: the blob store answers the whole log.
- **Pass `--allow-escape-sequences` only to a gh that knows it**: two rules for one read, and the older gh is the vulnerable one.
- **Through the cached reads**: a log is read once, and a megabyte each would push the cache's useful entries out.
