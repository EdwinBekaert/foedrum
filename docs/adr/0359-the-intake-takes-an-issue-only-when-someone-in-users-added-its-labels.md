# 0359. The intake takes an issue only when someone in users added its labels

Date: 2026-11-10 · Status: Accepted · Amends [0043](0043-target-repository-issues-as-a-work-queue-claimed-by-a-ref.md) (a candidate's intake labels were last added by someone in `users`, whoever opened it), [0050](0050-the-intake-of-target-repository-issues.md) (the pass reads the events of each issue that passes every other check, and `TargetTracker` reads them), [0068](0068-the-intake-in-foedrum-serve-brewery-orders-and-routing-by-label.md) (a target issue's author no longer bounds who labels it in), [0208](0208-orders-are-claimed-in-rank-order-by-arrival-unless-a-person-moved-one-with-foedrum-rank.md) (what `rank` says of an order not in the queue) and the [security page](../design/security.md) (who orders work in a target repository)

## Context
The intake took a target repository's issue when it carried the intake filter's labels and was opened by someone in the Brewery's `users` (`isCandidate`, [ADR 0043](0043-target-repository-issues-as-a-work-queue-claimed-by-a-ref.md)).
Who put the label on did not count, and that got both cases wrong (#903):

- A maintainer could not approve a community member's issue by labelling it. The Cellar skipped it in silence, however many labels it got, and the only way in was by hand with `foedrum brew`.
- Anyone who can label on that repository, such as someone with triage rights, could approve work for a Brewery by labelling an issue a `users` member opened. Opening an issue says nothing about wanting a Brewery to brew it.

ADR 0043 already noted that a label alone is no boundary: an issue template can add one for any author.
`users` belongs to the Brewery, and is usually one person, its owner, who adds colleagues when a team manages the repository.

## Decision

### Who added the label decides, not who opened the issue
- An issue of a target repository is a candidate only when each of the filter's labels was last added by someone in `users`, whoever opened it. Who opened it no longer counts.
- Who added a label comes from the issue's events (`GET /repos/{owner}/{repo}/issues/{n}/events`): the latest `labeled` event for that label, compared ignoring case as GitHub does. A label removed and added again counts by its latest adding.
- A label whose adder can't be told, as with a deleted account (a `null` actor), does not count. Neither does a label with no `labeled` event at all.
- A label an issue template adds at its opening is added by the person who opened it, so a stranger's template label never counts. An automation that labels counts only when its login is in `users`.
- `isCandidate` (`src/engine/issue-claims.ts`) is `mayBeCandidate` (open, not a pull request, filtered in, unassigned or this Brewery's, never brewed) and `unapprovedLabels`, which names each label nobody in `users` added last, and who did.

### Where the events are read
- `intakeQueue` stays synchronous and pure: `foedrum rank` and the property tests build the queue from listings already read. So the read goes between the listing and the queue, in one shared step, `withLabelsAdded` (`src/engine/intake.ts`), which the pass and `rank` both call.
- It reads the events only of an issue that passes `mayBeCandidate`, since each read costs a request, and leaves every other issue as it was listed. The listing carries no addings of its own: only this read fills `TargetIssue.labelsAdded`, and an issue without them is no candidate.
- `TargetTracker` gains `labelsAdded(repo, issue)`. On GitHub (`githubTargetTracker`, `src/github/tracker.ts`) it reads every page of the events through the conditional reads ([ADR 0052](0052-github-reads-rate-limit-pauses-and-the-polling-interval.md)), 100 to a page, since an event has no body anyone writes, and checks each item (`GitHubIssueEvent`, `src/schemas/github.ts`). It keeps them in the order of their ids, the order they happened, whatever order the pages give. A `labeled` event without its label fails the read rather than leave an adding out.

### A read that fails takes nothing
- A read of an issue's events that fails leaves the issue out for that pass, as an issue with no addings, never as approved. The pass goes on with the next issue.
- The Cellar says so once: `the intake failed reading who labelled <repo>#<n>: <error>`, and again only after a read of that issue succeeded and a later one failed.
- `foedrum rank` refuses with `cannot read the intake's queue: reading who labelled <repo>#<n>: <error>`, as it does for a listing it cannot read.

### What a person is told
- `foedrum rank <alias>#<n>` of an issue that passes every other check says why it is not in the queue, in place of "not opened by an allow-listed user": `the label <label> was last added by <login>, who is not in users`, `the label <label> was last added by a deleted account`, or `nobody in users added the label <label>`, one part per label. Any other order not in the queue gets `closed, filtered out, assigned to someone else or, for a Brewery issue, not opened by someone in users`.
- The Cellar's output says it once per issue and reason in a run of `foedrum serve`: `<repo>#<n> is not taken: <reason>`. A new reason, or a restart, says it again once; there is no line every pass.
- `foedrum status` shows batches, and a skipped issue has none, so it shows nothing of it.
- `foedrum init` says, after the intake labels: `An issue is brewed once someone in foedrum.jsonc's users adds foedrum:brew to it, whoever opened it; a team adds its colleagues to users`. The schema's description of `users` says the same.

### What does not change, and why
- **`foedrum brew` and `foedrum order` of a target issue** take no candidate check: they are a person in the Brewery choosing that issue, which is what the label stands for.
- **A Brewery's own issues** (`isBreweryOrder`) are still ordered when someone in `users` opened one with a `recipe:<name>` label ([ADR 0068](0068-the-intake-in-foedrum-serve-brewery-orders-and-routing-by-label.md)). The Brewery is the users' own repository: who can open an issue there is who it lets in, and a `recipe:` label routes the order rather than approve it.
- **`users` for commands in comments** stays as it is: a command is a person's own act, judged by who wrote it.
- **A comment reaching a brewer** is still heard from the repository's maintainers by association ([ADR 0333](0333-a-brewer-s-order-holds-the-maintainers-comments.md)): it informs an order someone already approved, and approves nothing.

### What it costs
- One more conditional read per candidate per pass, and one more per started 100 events of it, counted from the code: the pass reads the queue only while the Brewery has free capacity, and a candidate it claims has a batch and is no candidate at the next pass. What stays is an issue nobody in `users` labelled, one a limit holds ([ADR 0217](0217-a-recipe-s-concurrency-and-the-open-order-limit-hold-what-the-intake-starts.md)) and one past the free capacity.
- An unchanged answer is a 304, which does not count against the rate limit (ADR 0052). Ten such issues and a poll every 60 s, the default, make 600 requests an hour, of which only the first read of each and the reads after a change count, against 5,000 an hour.
- The ETags share the reads' cache of 256 answers with the listings and pull requests. A pass walks its paths in the same order every time, so past about 200 waiting candidates the least recently used answer is always the next one asked for: every read then counts, 12,000 an hour at 200, and the client pauses for the rate limit (ADR 0052). A Brewery with that many waiting issues raises `pollEvery`.

## Consequences
- A maintainer approves a community member's issue by adding the intake label, and someone with only triage rights, or a template, can no longer approve work for a Brewery.
- The Cellar is no longer silent about a labelled issue it does not take: it says once who added the label.
- Every fake `TargetTracker` in the tests answers `labelsAdded`; the shared `addedByAuthor` (`test/helpers/labels-added.ts`) gives each label to whoever opened the issue, and the fake GitHub API answers the events the same way unless an issue names `labelledBy`.

### Migration
- No file in a Brewery changes, but what it takes does. An issue labelled by someone not in `users` stops being taken after the upgrade, even if a `users` member opened it: someone in `users` has to add its label again (remove it and add it).
- A team adds its colleagues' GitHub logins to `users` in `foedrum.jsonc` first, so the labels they add count.
- A batch already ordered carries on: the check runs only before a claim.
- The pull request and the release notes say so.

## Alternatives considered
- **Read the events of every listed issue.** Simpler, but a request for each open issue at every pass, most of which fail a cheaper check first.
- **Read them in the listing** (`TargetTracker.issues`). It would read issues the queue drops, and `rank` and the pass would each need to know which.
- **The timeline API** (`/issues/{n}/timeline`). It holds comments with their bodies, so its pages are bigger and change at every comment, which spends the rate limit on what the intake does not read.
- **Keep the author check beside the label check.** It would keep out a community member's issue that a maintainer labelled, the first case #903 fixes, and add no protection: the label check already needs someone in `users`.
