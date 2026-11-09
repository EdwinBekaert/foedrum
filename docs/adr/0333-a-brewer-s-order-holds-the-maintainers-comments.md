# 0333. A brewer's order holds the maintainers' comments

Date: 2026-11-06 · Status: Accepted · Amends [0276](0276-the-order-a-review-reads-holds-its-recorded-scope-decisions.md) (a Brewery's Taster gets the comments now), [0041](0041-untrusted-input-in-per-prompt-nonce-tags.md) (what a comment's `source` says, and that comments enter by association, not by the allow-list), [0052](0052-github-reads-rate-limit-pauses-and-the-polling-interval.md) (a list reads on from a full page that answers 304), [0063](0063-foedrum-serve-its-configuration-and-wiring.md) (what the `order` input is) and [0332](0332-tasting-compare-real-re-tastes-brewed-heads-and-writes-blinded-lists.md) (a third setup of `--real`) · Amended by [0338](0338-a-resumed-session-hears-the-comments-made-since-it-last-read-them.md)

## Context
A brewer's `order` input was the issue's body and nothing else (`githubOrderText`).
A maintainer who narrowed, widened or settled the scope in a comment was heard by no brewer in a batch.
`/brew-review` closed that gap for itself in [ADR 0276](0276-the-order-a-review-reads-holds-its-recorded-scope-decisions.md), which traced 20 of 31 dismissed acceptance findings to scope recorded where the lens could not read it, and left the engine for an issue of its own.
The acceptance lens already spoke of the comments that follow the issue; in a batch there were none.

Three things make it more than a read:
- Foedrum posts with `gh`'s login, usually the maintainer's, so its own comments read as `OWNER`: #855's claim and release comments do.
- A claimed order has two issues, and a person now works on the Brewery issue ([ADR 0329](0329-one-number-per-piece-of-work.md)).
- Every brewer of every batch reads this input.

## Decision

### What the order holds
- **The body, then the comments of its repository's maintainers:** `authorAssociation` `OWNER`, `MEMBER` or `COLLABORATOR`, as ADR 0276 has them.
- **Each comment is an input of its own**, in the shape ADR 0041 gave it: its own tag, `name="order"` like the body.
  One string under headings would let a comment forge a heading, an author or a date.
- **Its `source` says who and when:** `comment <id> on <owner/name>#<n>, by <login> (<association>), <date>`, or `by a deleted account`.
  The repository is new to ADR 0041's form, since a target issue and a Brewery issue can share a number.
  `source` is an escaped attribute Foedrum writes, so the comment's text cannot reach it.
- **`authorAssociation` decides who is heard. It does not make the text trusted:** every comment stays inside the prompt's nonce tags, and one that holds the nonce refuses the prompt, as a body does.
- **The Brewery's allow-list plays no part.** The maintainer decided on 2026-11-06: association only. `users` says whose issues become orders and whose commands count ([ADR 0041](0041-untrusted-input-in-per-prompt-nonce-tags.md)); a comment is heard by its association alone, as ADR 0276 has them, so a collaborator who is not in `users` can write part of an order they could not open.
  `MEMBER` and `COLLABORATOR` do not imply write access: an org member with no rights on a target repository is heard there, and the acceptance lens counts what they say as a scope record. The tags, the tool allowlists, the sandbox and a person's merge still hold.
- No default brewer's text changes: the prompt's rule already says a `{name}` refers to "the inputs with that name".

### Foedrum's own comments stay out
- **A comment is Foedrum's when its author is the Brewery's login and its last line is an effect marker** (`isMarkedComment`).
  Both must hold: a marker alone proves nothing, since anyone can write one ([ADR 0033](0033-chaos-tests-effects-found-by-key-and-leases-at-start.md)), and the login alone is the maintainer's too.
- **It is one shape, not a list of kinds.** Every comment Foedrum posts ends in `<!-- foedrum:<key> -->`, so a new kind needs no entry here.
- **A poster cannot leave it out by accident:** the code host's `comment`, `create` and `edit` take only what `markedComment` builds.
  A test goes over every kind, and lists the files that call `markedComment` and those that post to an issue's comments. It catches what the type cannot: a new post that does not go through the code host's `comment` or `create`, and a new file of comments the table of kinds does not hold yet. A second kind in a file already listed fails nothing, and needs nothing, since the shape is the same.
- **No older comment lacks it.** Each poster wrote the marker from its first commit, and on 2026-11-06 every Foedrum comment on the Brewery's issues 1 to 20 and on #855, #864 and #867 ended in one. No older text needs recognising.
- **A marker in other hands:**
  - by any other login, it changes nothing: that comment is judged by its association, and stays in if a maintainer wrote it;
  - quoted, or followed by more text, it is no last line, so a reply that quotes a status comment stays in;
  - by a person posting as the Brewery's own login, ending a comment in a marker hides that comment from brewers. It takes that login, and hides only that person's own words.
- **Foedrum's comments under an earlier login** stay in, because the login is the driver's now: after `gh auth switch`, or with a second driver on another maintainer's login, an older status or plan comment by the other login reads as that maintainer's, model-written text included. A Brewery that changes its login deletes those comments from its open orders' issues, or accepts them.
- **Another Brewery's claim comment** on a target issue, by a login that is a maintainer there, stays in. It says only that the issue is being brewed, and telling Breweries apart would take a list of them.

### Which issues, in what order
- **A claimed order reads its target issue and its Brewery issue**, the Brewery issue once the ledger records it open.
- **Oldest first across both, by date, then by id.** A later decision reads last wherever it was made, and each `source` names its issue.
- **A person's standing is per repository.** `authorAssociation` comes from each repository's own answer: a collaborator of the Brewery is nobody on a target issue, and the other way round.
- **A sub-order reads its own issue only.** Its order's comments do not reach it: the approved plan's entry is what it was ordered from, and a comment that should change a sub-order belongs on the sub-order's issue.

### When they are read
- **When a fresh attempt is planned, as the body is.** A comment added while a batch brews reaches every attempt that starts fresh after it, and not one already running.
- **A resumed session does not hear it.** A resumed session holds the inputs its first attempt read, and reads none again ([ADR 0117](0117-a-retry-resumes-the-session-of-the-attempt-before-it-in-that-attempt-s-worktree.md)), for the body as for the comments.
  This is the case a maintainer will meet: they comment "not that way", then run `foedrum retry`, and a brewer that resumes never hears it.
  Among the default brewers **only the Brewmaster resumes** (`retryMode: "resume"`), on a retry and on an answer.
  Any brewer also resumes on the retry after a turn overrun ([ADR 0175](0175-a-turn-overrun-is-retried-by-resuming-its-session-and-keeps-its-out-doc.md)), and under `foedrum resume`.
  To be heard there, `foedrum rewind` the step, which schedules it fresh.

### When a read fails, or a thread is long
- **A failed read fails the attempt before claude starts,** as a failed read of the body does, with GitHub's status and the issue named. No order goes on without its comments.
- **A Brewery issue a person deleted holds no comments, and stops nothing** ([ADR 0144](0144-a-claimed-target-issue-gets-a-brewery-issue-that-is-its-order.md) keeps its batch going): GitHub's 410 that says deleted gives none.
  A 410 for issues turned off, or a 404, may come back, so each fails.
- **Reads are conditional and whole** ([ADR 0052](0052-github-reads-rate-limit-pauses-and-the-polling-interval.md)): every page is read, each answered from the cache on a 304. An edited or deleted comment shows as it now stands.
- **A full page that answers 304 reads the page after it.** Measured on 2026-11-06 with reads only: GitHub's ETag covers a page's body alone, since two URLs with one body and different `Link` headers share it and one answers 304 to the other's, and a 304 has no `Link` header. So an eleventh comment left a full first page unchanged, and the cached answer's `Link` ended the list at ten, in silence. `reads.pages` now asks for the next page after a page that came from the cache, is full and names no next; that request is conditional too. Every list gets this.
- **What an older run may have missed,** on a list whose items were an exact multiple of 10 when it was cached, with the new item appended past that page. None failed; each just did not see it until something on the cached page changed:
  - the tracker's listing of a repository's open issues, oldest first: a new order was not taken;
  - `findComment` and the status comment's `find`, oldest first: a comment Foedrum posted before a kill was not found by its marker, so it was posted again;
  - a parent's list of sub-issues: a sub-issue past that page was not listed.
- **What was never exposed:** the issues a login opened (`findIssue`), newest first, where a new one changes page 1; check runs and commit statuses, whose answers hold `total_count`, so a new one changes the body; pull requests, listed by one head.
- **No caller relied on the cut:** each wants every item. A read of a full last page costs one more conditional request, a 304 once that page is unchanged, and a list of exactly 5,000 items now fails on its second read, naming the limit, where it passed before.
- **Nothing is cut.** The body and the maintainers' comments together are one input's worth, 1 MiB. Past that the attempt fails: `the input "order" was not read: its body and <n> comments are larger than 1048576 bytes`. Only maintainers' comments count, so a stranger cannot fill it.

## Consequences
- **Cost:** one more listing per fresh attempt, two for a claimed order, a page per ten comments. An unchanged page is a 304, which does not count against the primary limit. Every read counts against the one token's primary limit, whichever repository it is in; there is no limit per repository. No model tokens go on reading them; the comments themselves go into each prompt.
- **A stranger's flood on a public issue can stop a batch.** Strangers' comments stay out of the prompt but are read: past the reads' limits (5,000 items or 32 MiB, about 85 of the longest comments) the listing fails, and each attempt fails naming the limit it passed: `the comments of <repo>#<n> has more than 500 pages`, or `is longer than 33554432 bytes`. A person sees it on the Stuck batch, and can delete the comments or lock the issue. `findComment` already has this exposure on a claimed issue, so it adds no new kind of risk.
- **A hidden comment is still read:** the REST answer does not say a comment was minimized. A decision withdrawn should be edited, deleted or answered by a later comment.
- **A private Brewery issue's comments reach brewers whose pull request goes to a target repository that may be public,** and a model could quote one. A plan already crosses that way, so this adds no guard; a maintainer should write on the Brewery issue what they would let a brewer repeat.
- **The Brewery:** no file changes, and no event changes.
  A running batch's later fresh attempts see the comments once the driver restarts on this version.
  A Brewery with its own copy of a brewer keeps its prompt, and gets the comments all the same: its `{order}` names them too. A Brewery's own copy of the acceptance lens keeps its old words, "the order file", and its Tasters get the comments as inputs all the same; it may take the default's sentence.
- **The maintainers' comments now count as scope in a batch,** as they do in a review: an order whose scope changed in a comment is judged as recorded there.
- **Measured:** `node scripts/tasting-compare.ts --real` gets a third setup, `867-comments`, on #867 only, the one order with a maintainer's comment from before its brew, in its exact words and with no later one. It differs from `867-reads` only by that comment. No numbers exist until the maintainer runs it.
- The default brewers are tried by the maintainer on real issues after the merge; the tests use the fake runner.

## Alternatives considered
- **One string, with the comments under headings as `/brew-review`'s `order.md` has them:** fewer tags, but a comment could write a heading or a date of its own. `order.md` is read by Tasters told it is one file; a prompt has the better form already.
- **Recognise Foedrum's comments by a list of markers:** one entry per kind, and a new kind that misses the list reads as a maintainer's instruction, with no error.
- **Recognise them by author alone, or by a bot account:** Foedrum posts with `gh`'s login ([ADR 0073](0073-github-only-through-gh-s-own-login.md)), which is the maintainer's.
- **Issue by issue, target first:** easy to read, but a decision on the target issue would read after a later one that overrode it on the Brewery issue.
- **Read them once, when the batch starts, and keep them:** one request, but a person who answers a batch Stuck by commenting would not be heard by the attempt they retried.
- **Give a resumed session the comments added since it started:** this is what would close the case above, and it is left out: it needs a decision of its own on what a session is told, and when.
- **Cut a long thread:** ADR 0276 cut nothing until a long one is seen, and a cut loses a decision in silence.
