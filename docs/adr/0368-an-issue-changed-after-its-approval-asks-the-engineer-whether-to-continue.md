# 0368. An issue changed after its approval asks the engineer whether to continue

Date: 2026-11-10 · Status: Accepted · Amends [0359](0359-the-intake-takes-an-issue-only-when-someone-in-users-added-its-labels.md) (the label approves the issue as it is when it is labelled, and a later change asks) and [0333](0333-a-brewer-s-order-holds-the-maintainers-comments.md) (a comment added after the approval stops a claimed order's batch until the engineer answers)

## Context
Since [ADR 0359](0359-the-intake-takes-an-issue-only-when-someone-in-users-added-its-labels.md), a target repository's issue is approved for a Brewery by its intake label, when someone in `users` added it, whoever opened the issue.
Its author can still edit the title and the body after that, and anyone who can comment can add a comment.
Every fresh attempt reads the body again ([ADR 0333](0333-a-brewer-s-order-holds-the-maintainers-comments.md)), so text written after the label reached the brewers: the label approved text the person who set it may never have seen (#976, found by the security lens on #903).

The maintainer decided on 2026-11-10: when the title or the body changed, or a comment was added, after the approving label, Foedrum asks the engineer whether to continue, and never goes on by itself.

## Decision

### What approves an issue, and when
- **The approval** of a claimed order's issue is the latest moment each of the intake filter's labels had last been added by someone in `users`, at or before the batch was ordered. A label added after the order approves nothing the order took; a label a stranger adds again moves nothing.
- **A person's order** (`foedrum order`, `foedrum brew` of a target issue, ADR 0105) approves the issue as it was when they ordered it: the batch's `orderedAt`, now kept with `orderedBy` in the fold.
- **The engineer's "continue"** approves the issue up to the latest change the question showed (`upTo`), recorded as `order.approved`. A change after that asks again.
- **An issue with no approval at all**, such as one whose filter has no label any more, counts every change it ever had.
- **A Brewery order** (`isBreweryOrder`) is never checked: no label approves it, and the Brewery is its users' own repository (ADR 0359). That holds for the Brewery issue of a claimed order too.

### What counts as a change
- **The title:** each `renamed` event after the approval.
- **The body:** each edit after the approval.
- **A comment:** each comment made or edited after the approval (its `updated_at`), whoever wrote it, maintainers and `users` included.
- **Foedrum's own comments never count:** its login's comments that end in an effect marker, as ADR 0333 tells them.
- An edit, a rename or a comment by someone in `users` counts too: the maintainer decided there is no exception.

### Where the check sits
- **The driver checks before each attempt of a claimed order starts** (`changedOrder` in `src/engine/driver.ts`), before `step.started` is recorded, so no prompt is built and no process starts. Every attempt: a brewer's, a resumed one's, a check's and an action's, since the pull request takes the issue's title (ADR 0071).
- **A change parks the scheduled attempt** with the engine command `order_changed`: the batch goes Stuck with the reason `order_changed` (the step, the first five changes, how many more, and `upTo`), and its options are `answer` and `cancel`. The abandoned attempt counts against no retry, as a Stuck that abandons an attempt before it starts never does (ADR 0222).
- **A check that cannot read the issue fails the attempt before it starts,** retryably, with `the order could not be checked for changes since its approval: <error>`. No attempt goes on unchecked.
- **Before a batch exists, nothing changes:** the intake claims the issue as ADR 0359 has it, and the check before the first attempt asks at once. `foedrum rank` says nothing new. The claim label and the claim comment land on the target issue before the engineer can say no.

### The question
- One question, `The issue changed after it was approved: continue with it as it is now, or stop?`, answered with `foedrum answer <n> continue` or `foedrum answer <n> stop`.
- **Continue** records `order.approved` with the question's `upTo`, resumes the batch and schedules the step's attempt again as it was scheduled (its route, retry and answered marks), never as an answer a brewer reads.
- **Stop** records `batch.cancelled`, as `foedrum cancel` does, with the claim's release that follows it.
- **Where it shows:** `foedrum stuck` (the changes, the issue's link and the question), `foedrum status` (the changes on the batch's line), the status comment (the changes, the issue's link, and the two commands), and `foedrum brew`'s Stuck line. The issue's link is built for github.com, as the clone URLs are.

### How it is read
- **The events** of the issue, every page, 100 to a page, through the conditional reads (ADR 0052): who added each label and when (`created_at`, now read), and each `renamed` event. The same path ADR 0359's intake reads.
- **The edits of the body,** which only GraphQL tells: `userContentEdits` (each edit's time and editor) and `lastEditedAt`. A title change does not set `lastEditedAt`: measured on 2026-11-10 on this repository's #902, renamed with no body edit, whose `lastEditedAt` is null. An issue with more than 100 edits counts its latest edit as by nobody known.
- **The comments,** every page, 10 to a page by the same path ADR 0333's comments read, with `updated_at`, so the two share the cached answers.

### What it costs
Counted from the code, per attempt of a claimed order:
- the events: one conditional request per started 100 events, a 304 when unchanged, which does not count against the primary limit (ADR 0052);
- the comments: one conditional request per started 10 comments, the same requests the order's comments make on a fresh attempt, so a 304 for both reads once the first is cached;
- the edits: one GraphQL query, a POST with no conditional answer, so every one counts: one point of the GraphQL limit of 5,000 points an hour, apart from the REST limit.

Nothing per candidate per pass: the intake reads no more than ADR 0359 has it.

## Consequences
- **No text written after the approval reaches a brewer without the engineer's continue,** but for one gap: an edit of the body made in the seconds between the driver's check and the plan's read of the body reaches that one attempt, and the next attempt's check asks about it. Closing it would read the body's edit time again where the body is read, one more counted GraphQL point per attempt.
- **Anyone who can comment can make Foedrum ask again,** on a public repository a stranger with one comment. Nothing is built from the new text until the engineer says continue, so it costs the engineer's time, not trust; locking the issue stops it.
- **What reaches a brewer does not change here.** A stranger's comment made before the label is still left out of the order, as ADR 0333 has it. When [#985](https://github.com/EdwinBekaert/foedrum/issues/985) lands, every comment up to the approval will reach the brewers, by time, read against the approval this record defines; until then nothing in this record changes what a brewer reads.
- **The two Stuck options** are `answer` and `cancel`: a retry, a skip or a rewind would start an attempt on the changed text without the question's answer.
- **An older Foedrum cannot read `order_changed` or `order.approved`.**

### Migration
- No file in a Brewery changes.
- A batch already running when this lands may stop at its next attempt with the question, when its issue was edited, retitled or commented on after its label; the engineer answers `continue` once to go on as before.
- A Brewery with several drivers updates them together: an older driver refuses to fold the new event and reason.
- The pull request and the release notes say so.

## Alternatives considered
- **Leave the issue out at the intake, and let `rank` say why:** a counted GraphQL read per candidate per pass, 600 points an hour for 10 waiting issues at the default poll, and nobody is asked, only told; re-adding the label would be the only way in.
- **Count only the comments that reach a brewer (by association), or except those of `users`:** fewer questions, but the maintainer decided that any change by anyone but Foedrum asks.
- **Reuse `needs_input`:** its answer is given to the brewer's session as input, so "continue" would reach a prompt.
- **One GraphQL query for everything** (labels, renames, edits, comments): one counted point, but every read would count, the comments would be read twice per fresh attempt, and ADR 0359's events read would be duplicated.
- **Compare the text with a copy kept at the claim:** it misses an edit made between the label and the claim, which only the edit history shows.
