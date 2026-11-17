# 0418. A refused push waits as push_refused with each finding's line, and takes stop

Date: 2026-11-17 · Status: Accepted · Amends [0079](0079-the-push-scans-the-batch-s-commits-for-secrets.md) (what a refused push makes the batch Stuck with, and that a finding names its line)

## Context
The push scans every commit it would send for what looks like a secret ([ADR 0079](0079-the-push-scans-the-batch-s-commits-for-secrets.md)).
A finding records the refusal in the ledger for good, and the openPullRequest action's attempt ends blocked on its environment, so the batch goes Stuck with the reason `blocked`.
That reason carries only a summary: the first three findings, each a commit, a place and a kind, and a count of the rest.
It offers retry, skip, recipe, rewind and cancel; a retry or a rewind meets the same recorded refusal again (ADR 0079).

So a person who looks at a refused push learns which file, but not where in it, and is offered commands that cannot get the batch moving.
Issue #249 asks that a person can let a refused push go after looking at its findings.
The maintainer settled it on 2026-11-17 in three answers on the issue, and split it in two: this record makes a refused push a Stuck reason of its own that shows what was found and takes `stop`; letting the push go (`allow`, recorded with who and why, for that exact commit) is #1149's, which writes its own record.

## Decision
- **A finding names its line** (`ScanFinding.line`, `src/formats/commit-scan.ts`): in a file, the line of the file as the commit has it, counted from each hunk's header; in a message, the line of the message, its subject being line 1.
  A header, a binary file and a path that looks like a secret have none.
  A finding stays one per commit, place and kind, as before, at the first line of that kind there, so a file with many fixtures does not crowd out the others.
- **Never the text.** The line's number is shown, never the line itself nor `findSecrets`' excerpt of it, as ADR 0079 and [ADR 0088](0088-out-doc-text-that-looks-like-a-secret-is-left-out-of-the-pull-request-and-the-status-comment.md) have it: the status comment of a public repository is read by anyone.
- **A refused push is a Stuck reason of its own,** `push_refused`: the openPullRequest step, the commit the push would have sent, the first 10 findings the ledger kept (it keeps 50) and how many more.
  The action's blocked ending carries the refusal (`refused`, built by the action's `ending` from the ledger's push result), and the decision makes the batch Stuck with it (`pushRefusedReason`, `src/engine/push-refused.ts`).
  The attempt's `step.finished` still records the failed outcome with the summary, as before.
- **It asks one question,** `The push was refused for what looks like a secret in its commits: stop the batch?`, answered with `foedrum answer <issue> stop`, which records `batch.cancelled` as `foedrum cancel` does.
  Any other answer is refused, naming stop.
  Its options are `answer` and `cancel`: a retry, a skip or a rewind would meet the same recorded refusal, or go past the push.
- **Where it shows:** the status comment says `the push of <commit> was refused before anything left the machine` and lists each finding on a line of its own, `<kind> in <place> line <n> of <commit>`, then how many more, with `Next: look at each finding above, then end the batch with foedrum answer <issue> stop.`; `foedrum stuck` lists the same lines and the question; `foedrum status` and `foedrum replay` show them on the batch's lane line; the lane label is `foedrum:awaiting-answer`, and the batch reads as Waiting for you, to answer a question ([ADR 0385](0385-a-person-reads-a-batch-as-one-of-four-states.md)).
  A commit is named by its first eight digits.
- **From a GitHub comment,** the answer is an answer like every other: only the Brewery's `users` may give it, when commands in comments come; nothing here reads comments.

## Consequences
- A person sees where each finding is before deciding, and is offered only what can move the batch.
- A refused push stays refused for the batch's life, as ADR 0079 has it; once #1149 lands, `allow` lets that one commit go.
- `batch.stuck` gains a reason, `push_refused` (`schemas/event.json`), and a scan finding an optional `line`; an older Foedrum cannot read an event log that holds either.
- A ledger push result recorded before this record has findings without lines: the lines show where they are, the others show without one.

### Migration
- No file in a Brewery changes.
- A batch already Stuck as `blocked` on a refused push stays so; `foedrum cancel` ends it as before.

## Alternatives considered
- **Show the line's text, masked or whole:** the person would see more, but the status comment would publish part of what looks like a secret; the line's number and the kept branch (ADR 0084) are enough to look at it locally.
- **One finding per line:** every fixture of a test file would be its own finding, and 50 of them would fill the ledger's list before the next file.
- **Keep `blocked` and add the findings to it:** every reader of `blocked` would have to tell a refused push from any other environment block, and the options would still offer commands that cannot help.
