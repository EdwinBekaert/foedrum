# 0225. A ready pull request gets a merge brief

Date: 2026-10-26 · Status: Accepted · Amends [0072](0072-the-status-comment-edits-as-revisions-in-the-ledger.md) (the status comment links the brief), [0213](0213-an-open-pull-request-s-checks-on-its-head-are-recorded-once-they-finish.md) (what #551 reads, now built) and [0214](0214-a-taster-s-out-doc-says-what-risk-is-left.md) (the brief's Risk left heading)

## Context
A brewed pull request has its body, the change ([ADR 0167](0167-a-brewed-pull-request-follows-one-layout-and-opens-as-a-draft-unless-every-taster-approves.md)), and the status comment on the order's issue, the steps ([ADR 0072](0072-the-status-comment-edits-as-revisions-in-the-ledger.md)).
Nothing on the pull request tells the person who merges that it is ready and why (#551, split from #274).
The maintainer settled on #274 (2026-10-25 and 2026-10-26): the body is the change, the brief is the decision for one head; it appears only when the pull request is ready, with one verdict, "Ready to merge"; not ready means the work goes on ([ADR 0219](0219-a-failing-check-on-an-open-pull-request-sends-its-batch-back-to-a-fix-step.md)); every check counts, not only required ones; the judgement is the last Taster's risk left, with no new brewer run ([ADR 0214](0214-a-taster-s-out-doc-says-what-risk-is-left.md)); conflicts with other open pull requests stay out (#550).

Four facts shaped it.
The latest record of a head's checks says how they stand now, never for good: a re-run or a late check changes it ([ADR 0213](0213-an-open-pull-request-s-checks-on-its-head-are-recorded-once-they-finish.md), #551's comment).
A head with no checks is recorded finished only one pass after it was first seen, so a pull request whose CI had not registered yet is never ready (ADR 0213, "the mistake #551 must never make").
An effect is found by its marker on the Brewery's own comment, so a kill between a post and its ledger entry posts once ([ADR 0033](0033-chaos-tests-effects-found-by-key-and-leases-at-start.md), [ADR 0209](0209-a-check-that-fails-on-an-open-pull-request-s-merged-tree-is-posted-on-it.md)).
And a finding's `why`, a dismissal's reason and a risk-left item are a model's words, which a pull request comment must not render as Foedrum's own ([ADR 0088](0088-out-doc-text-that-looks-like-a-secret-is-left-out-of-the-pull-request-and-the-status-comment.md), [ADR 0184](0184-a-brewed-pull-request-keeps-what-a-code-span-holds-and-writes-each-attempt-as-one.md)).

## Decision

### Ready
- **One pure function, `readyOf(state, batch)`** (`src/engine/merge-brief.ts`, a module of its own, read as `failedPullRequest` is), gives the pull request, its head and the digest of its checks when it is ready, else nothing:
  - `openOf` gives the open pull request and the head of the batch's latest push: On tap, opened by its ledger, no recorded end, no push by someone else, and the latest push not moved, gone, empty or refused;
  - the latest record of its checks (`Batch.pullRequestChecks[url]`) is finished, on that head, and `checkPassed` passes every check it keeps; a record keeps the failed checks first, so the ones it left out (`more`) passed too;
  - the pull request's latest base check, if any, has no `conflicts` and no `failed`; an `unchecked` one does not hold it up and the brief says the checks did not run on the merged tree;
- **No open blocking finding needs no check of its own**: a batch is On tap only once each step succeeded, was skipped by its `when`, or a person's skip went past it. A blocking Taster's step whose latest attempt ended blocked by findings (`onFindings`) is On tap only after such a skip, and the maintainer decided (2026-10-26) that it is ready then: the person accepted those findings, and the brief lists them as left open by a skip, so whoever merges sees what was accepted.
- **A head with no checks is ready** once ADR 0213 records it finished with none, one pass after it was first seen; the brief says no check ran on it.
- **A paused order still gets its brief**: it records a fact and runs nothing ([ADR 0202](0202-pause-and-continue-hold-an-order-or-the-whole-brewery-at-its-next-convenient-point.md)).

### One brief per ready record
- **Numbered `[batch, "brief.<n>"]`, from 1**, its ledger result `{ comment, pullRequest, head, digest }` (`MergeBrief`, `src/schemas/status-comment.ts`, beside `StatusRevision`): the comment's id, and the record it was posted for, `digest` being the first 16 hex digits of the SHA-256 of the record's checks as `sameHeadChecks` compares them (`headChecksText`, `src/engine/fold.ts`).
- **Due** (`mergeBriefEffects`, `src/engine/merge-brief-post.ts`) when `readyOf` gives a record and the latest brief recorded is of another pull request, another head or another digest. A record that goes pending and finishes again with the same checks posts nothing: the brief still holds. A re-run that turns a failure green posts; a new head's ready record posts the next number.
- **Found by its record and its marker before it is applied**: a hidden line right before the marker, `<!-- foedrum:brief <pull request> <head> <digest> -->`, names the record it was posted for, and a brief is taken as posted when one of the Brewery's own comments on the pull request ends with that line and its marker. So a kill between the record and the post, or between the post and its ledger entry, posts once, whatever else changed meanwhile (a base that moved changes the text, not the record). If the record changed between a kill and the next driver, the comment there is an older record's brief: it stays, and this record's brief is posted under the same key, and found among both after a later kill. No model text can write the line: `plain` writes each `<` as `&lt;`.
- **A brief whose head is no longer ready stays as posted.** Hiding an outdated brief is #549's.

### The text
- **Title**: `### Merge? <title> @ <short sha>`. The pull request's title is read at apply through the code host's issue read (`IssueMarks.title`: GitHub answers a pull request's number on its issues endpoint), untrusted, escaped by `plain`. Then `Foedrum · batch <id>`.
- **Verdict**: `**Ready to merge.**`, why (every check on this head finished and passed, nothing else is open) and that it waits on a person: Foedrum never merges, the pull request merges when whoever merges it does.
- **What changed since it opened**: each fix round a failure sent back (ADR 0219): its number, the head whose checks failed, and the commit its push recorded (a round whose push is not recorded yet says it pushed nothing yet); or "nothing". The failed checks of an earlier round are not named: the fold keeps only the latest record of a pull request's checks.
- **Evidence on `<sha>`**:
  - each check of the record with its conclusion and link, as the Stuck reason writes them, and how many more passed; or that no check ran on this head;
  - how it merges with its base by the latest base check: cleanly at its tip, or not checked on the merged tree and why; or not checked against its base since the push;
  - the red proof's readings (`readingText`) when it succeeded, or "not run" with the `when` that was false, or that the recipe has none;
  - each other check step's latest success: the checks it read, and the ones it skipped because the repository has none, as not run;
  - each recipe step that did not run, with the `when` that was false, and each whose latest attempt did not succeed and that a person's skip went past, but a blocking Taster's step blocked by findings, which Findings lists;
  - the commit the last Taster reviewed and the fix rounds since (`tasted at <sha>`, from the ledger, no git);
  - the sensitive paths the latest push recorded (`sensitiveLine`, [ADR 0201](0201-a-repository-names-its-sensitive-paths-and-a-batch-that-touches-one-says-so.md)).
- **Findings**, a heading of its own, since its lines hold a model's words: the findings each route round answered, `fixed`, `dismissed` or `pre-existing` with its reason, at its place, with the step whose findings it answered and the lens of the finding at that place (`lensRounds`: a blocked round's findings as `step.finished` records them, [ADR 0221](0221-foedrum-lenses-reports-each-lens-s-findings-their-ends-and-its-tokens.md), each disposition paired with the first finding at its place not already taken, as a later round's input pairs them); and the findings of each Taster's step whose latest attempt succeeded, as the status comment lists them, each after its lens when it names one; and each blocking Taster's step blocked by findings that a person's skip went past, as left open by a skip, with its attempt and each finding its round recorded (ADR 0221), at most ten with a count of the rest.
- **Risk left**: the last Taster's `riskLeft` (ADR 0214: the last tasting step in the recipe's order, its latest attempt when it succeeded, or each child of a parallel group), each item after its step; or "none recorded".
- **Every model text** (a finding's `why`, a disposition's reason, a risk-left item) goes only under its heading, on one line: `withoutSecrets`, then `unlinked`, then `plain`, so a text that looks like a secret is left out for a fixed line, no closing keyword, mention or character reference survives, and nothing a brewer wrote renders as Markdown or HTML (so no `<!--` either). Each list is capped with a count of the rest, and the whole text is cut to whole lines below GitHub's limit, as `renderStatus` cuts.

### The status comment
- **One more line under its pull requests**, after the checks line: `- <url> is ready to merge on <sha>: <url>#issuecomment-<id>`, from the latest brief while it is of the record `readyOf` gives now; else nothing more.

### What this is not
No hiding of an outdated brief (#549), no body render (#548), no conflict or merged-tree route (#547), no conflicts with other open pull requests (#550), no brewer run, and Foedrum never merges.

## Consequences
- A ready brewed pull request gets one comment a person can merge from without reading the steps, and one more each time its ready record changes.
- One ledger entry per brief; no new event, no change to the fold or the admission.
- A base check records no head, and none runs again until the base moves: a conflict recorded on a head before a fix round holds the next head's brief until the base moves and that head is checked (#547 sends a conflict back along the route).
- A pull request whose blocking Taster's findings a person skipped gets a brief that says so.
- After a kill and a changed record, an older brief and the new one can carry the same marker; the ledger names the new one.
- A person who edits the pull request's title sees it in the next brief, not in one already posted.

## Alternatives considered
- **No brief while a skipped blocking step's findings are open**: the skip is the person's acceptance of them; holding the brief back would leave a pull request a person chose to let through with nothing that says it is ready (the maintainer, 2026-10-26).
- **Read GitHub at post time to decide ready**: the record is the one fact the engine, the status comment and the fix route agree on; a second reading could disagree with them.
- **Ready on the first finished record of a head**: a late check makes it pending again (ADR 0213), and the brief would stand for a record that no longer holds.
- **One brief per head, not per record**: a re-run that turns a failure green, or a late check, would change the evidence and post nothing.
- **Take any comment found by its marker as posted**: after a kill and a changed record, the ledger would call an older record's brief this one's, and the status comment would link it.
- **Compare the whole text after the title**: anything else the brief shows (a base check that came after the kill) would post the same record's brief again (review of #579).
- **`GitHubPullRequest` gains `title`, read through the intake's tracker**: a second reader of the same title the issue read already gives, beside the tracker's other callers.
- **Name each earlier round's failed checks**: needs the fold to keep each round's record; the round, its head and its push say what changed, and the status comment's history has the rest.
- **A disposition's lens of its own**: a disposition names a place, not a lens; the finding at that place, which the log records since ADR 0221, already says it, and a second field would have to agree with it.
- **A brewer run to write the brief**: rejected by the maintainer (2026-10-25); the engine writes the facts and the last Taster the judgement.
