# 0420. foedrum answer allow lets a refused push of one exact commit go, with who and why

Date: 2026-11-17 · Status: Accepted · Amends [0079](0079-the-push-scans-the-batch-s-commits-for-secrets.md) (a refused push no longer stays refused for the batch's life: a person can let its commit go), [0418](0418-a-refused-push-waits-as-push-refused-with-each-finding-s-line-and-takes-stop.md) (a refused push takes a second answer, `allow`) and [0030](0030-only-commands-that-change-state-are-recorded.md) (the allowance is recorded with who and from where, as every command that changes state)

## Context
Since [ADR 0418](0418-a-refused-push-waits-as-push-refused-with-each-finding-s-line-and-takes-stop.md), a push the secret scan refused makes the batch Stuck as `push_refused`, lists each finding by kind, line, commit and place, never the text, and takes one answer, `stop`.
The scan fails closed ([ADR 0079](0079-the-push-scans-the-batch-s-commits-for-secrets.md)): a fake token a test builds as a literal, a binary file or a submodule bump stops the push as a real secret would, and the ledger keeps the refusal for the batch's life, so `stop` was the only way on.
The maintainer settled on 2026-11-17, in three answers on #249: a person allows a refused push for that exact commit, all its findings at once, recorded with who and why; a new commit is scanned again; no folders the scan skips; the answer is `foedrum answer <issue> allow "<why>"`.
This record is the second half of #249, issue #1149.

## Decision
- **The answer.** `foedrum answer <issue> allow "<why>"` on a batch Stuck as `push_refused`: the words after `allow` are the reason, joined with a space.
  The reason is required: none, or a blank one (`allow ""` too), is refused with `allow takes a reason: foedrum answer <n> allow "<why>"`, from the engine (`allowOrStop`, `src/engine/decide.ts`), so every surface gets the same refusal.
  `stop` ends the batch as before; any other answer is refused naming both.
  The question becomes `The push was refused for what looks like a secret in its commits: allow the push of this commit, or stop the batch?`.
- **The event.** The answer records `push.allowed` with the batch, the openPullRequest step, the full sha of the commit the Stuck reason names, `why`, `by` and `via`, then `batch.resumed`, and schedules the step again as it was scheduled (its route, retry and answered marks), as an issue's `continue` does ([ADR 0368](0368-an-issue-changed-after-its-approval-asks-the-engineer-whether-to-continue.md)).
  It is admitted only on a Stuck batch.
  The fold keeps the latest allowance on the batch (`pushAllowed`).
- **The push after an allowance.** When a round's push recorded a refusal of the commit a person allowed, the action pushes under a key of its own, `push.allowed` in the first round and `push.<n>.allowed` after (`allowedPushKey`, `src/engine/pull-request.ts`), so the refusal stays in the ledger as it was.
  That push skips the scan only when the commit it resolves is exactly the allowed one; any other commit is scanned as before, and a finding is recorded under that key.
  An allowance of one commit never reaches another: a later round's push of new commits goes under `push.<n>` and is scanned.
- **The readers** of a round's push (`recordedPushes`, so `latestPush`, `openOf`, `knownCommits`, the merge brief and the worktree claims) take the allowed key's result first, then the round's own.
- **Where it shows:**
  - while Stuck, the status comment's Next: line: `Next: look at each finding above, then let the push of this commit go with foedrum answer <n> allow "<why>", or end the batch with foedrum answer <n> stop.`, and `foedrum stuck`'s question line ends `(allow "<why>", stop)`;
  - after an allowance, under the openPullRequest step's line of the status comment: `- its push of <commit> was allowed by <by> (<via>): <why>`, the reason shown as other text a person wrote ([ADR 0088](0088-out-doc-text-that-looks-like-a-secret-is-left-out-of-the-pull-request-and-the-status-comment.md));
  - `foedrum replay` shows the event, and its State gains `allowed push <commit> at <step> by <by> via <via>: <why>`.
  A commit is named by its first eight digits.
- **Nothing per finding, and no folders the scan skips,** as the maintainer settled.

## Consequences
- A batch stopped by a fake token, a binary file or a submodule bump can go on after a person looked at its findings, and the log says who let it go and why.
- What the person allowed is one commit: the pushed tip, with every commit from the base to it, as the refusal listed them.
- If the push after an allowance resolves another commit than the allowed one and the scan refuses it, that refusal is kept under the allowed key, and only `stop` (or a cancel) moves the batch on: `allow` is still offered and accepted, but an allowance of the second commit brings back the first refusal, and one of the first the second, and nothing is pushed. No guard stops that answer, since nothing reachable today moves the task tree between a refusal and the push after its allowance.
- `push.allowed` is a new event (`schemas/event.json`); an older Foedrum cannot read an event log that holds it.

### Migration
- No file in a Brewery changes.
- A batch Stuck as `push_refused` before this lands takes `allow` as any other does.

## Alternatives considered
- **Record the allowance on the push result, under the round's key:** the ledger keeps one result per key for good, so the refusal would have to be overwritten, and an effect applied once could not apply again.
- **Allow per finding:** settled against; one commit at a time is what a person can look at, and a new commit is scanned again.
- **Skip folders the scan reads (fixtures):** settled against for now; to be revisited only if refused pushes on fake tokens turn out to be frequent.
