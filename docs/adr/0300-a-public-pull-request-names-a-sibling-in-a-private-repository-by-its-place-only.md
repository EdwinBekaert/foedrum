# 0300. A public pull request names a sibling in a private repository by its place only

Date: 2026-11-01 · Status: Accepted · Amends [0292](0292-the-pull-requests-of-one-order-name-each-other-and-the-merge-order.md) (the sibling section names a sibling only where its repository's readers cover the pull request's)

## Context
Since [ADR 0292](0292-the-pull-requests-of-one-order-name-each-other-and-the-merge-order.md) each sub-order pull request's body starts with a section that names its siblings as `owner/name#n`.
For an order split across `acme/web` (public) and `acme/internal-billing` (private), the public pull request read `acme/internal-billing#12`.
GitHub hides that pull request's contents from outsiders, but the repository's name, and that it has a pull request of this change, is in a public body.
The maintainer accepted that for ADR 0292 as a known risk, to be closed by #746.
Foedrum read no target repository's visibility: only `foedrum init` reads the Brewery's repository (`src/github/brewery-repository.ts`).
GitHub's `GET /repos/{owner}/{repo}` answers `private` and, on newer answers, `visibility` (`public`, `private` or `internal`).

## Decision
- **The driver reads each target repository's visibility** that `foedrum.jsonc` lists, through `GET /repos/{owner}/{repo}`, once when it opens (`repositoryVisibilities`, `src/github/repository-visibility.ts`, read by `wireDriver`, so `serve`, `brew` (and with it `lauter`) and `resume` of a running batch read it alike).
  A repository is `public` only when the answer is 200, `private` is false and `visibility` is `public` or absent; `internal` when `visibility` is `internal` (every member of its enterprise reads it); `private` for any other 200 answer; any other status (a 404, which GitHub gives for a repository the login cannot see, a 403 of a rate limit, a 5xx), an answer of another shape, or a read that fails is `unknown`.
- **A repository whose visibility is `unknown` is read again after each tick**, at most once a tick, until GitHub answers it; one read `public`, `internal` or `private`, or answered 404, is not read again in that run.
  So an offline start or one failed read does not hide every sibling for a whole `serve`, which can run for days, and a repository that answers 404 is not read every tick: it stays `unknown`, hidden as a sibling and hiding its siblings as a pull request's own, since another read would not change what the login can see.
  The reads of one tick run at once, and after the tick, which renews the leases first: a GitHub that hangs holds the next tick up by one request's timeout, never a lease by one per repository.
- **No event records it.** Visibility is the code host's fact, not Foedrum's state; `siblingSection` takes it as an argument (`VisibilityOf`) and stays a pure function, its digest stable within a run.
- **A sibling is named only where everyone who reads this pull request can read it too.**
  Each visibility has an audience, and a sibling is named when its repository's audience is at least this pull request's:

  | Visibility | Audience | For example |
  |---|---|---|
  | `public` | 2 | `acme/web`, which anyone reads: named in every pull request |
  | `internal` | 1 | `acme/portal`, which the enterprise reads: named in an internal or a private pull request, hidden in a public one |
  | `private` | 0 | `acme/internal-billing`, which some teams read: named only in a private pull request |
  | `unknown` | 0 as a sibling, 2 as this pull request's own | a sibling whose read failed is hidden as a private one; a pull request whose own read failed hides every sibling that is not public |

  So a private pull request names every sibling as before, and a public one only its public siblings.
  A hidden sibling's line reads `<n>. A pull request in a private repository: <state>, <when>.`, and other lines refer to it as `pull request <n> (in a private repository)`, `<n>` its place in the merge order, so two hidden siblings stay apart.
  A `release` dependency on a hidden sibling reads `… merges and its repository has a release after it`.
  A hidden sibling that has no pull request yet is hidden the same way, its repository unnamed.
  An `unknown` sibling counts as private and an `unknown` pull request of one's own as public, so a name is never shown by mistake.
  A hidden `internal` sibling is called a pull request in a private repository too: to a reader of a public pull request it is one.
- **The order's status comment is unchanged**: it is in the private Brewery and names every pull request (`subOrderPullRequests`).

## Consequences
- A public pull request's body names no private or internal repository of its order, nor the number of its pull request, and an internal one names no private one.
- **A visibility that changes between runs changes the section**, so its digest differs and `siblingEffects` writes a revision in the next run's first pass, while the pull request is open.
  A merged body is revised only when a sibling opened since, and a closed one never (ADR 0292), so a visibility change does not rewrite those: their edit history on GitHub keeps the old text anyway.
- A visibility that changes during a run is seen by that run only when it was `unknown`; otherwise the next run sees it.
- While GitHub cannot be read, each tick makes one more request per `unknown` repository, all at once; a repository the login cannot see makes one request a run.
- A body written before this record still names its private siblings until its next revision, or as it merged.

## Alternatives considered
- **Read visibility once per run only**: one failed read at the start would hide every sibling for as long as the run lasts.
- **Record visibility as an event**: it is GitHub's fact, and an event would make the store keep a copy that goes stale.
- **Count a 404 as `private`**: a pull request whose own repository answered 404 would name every private sibling.
- **Count `internal` as `private`**: an internal pull request would name its private siblings to every member of the enterprise.
- **Read before the tick, one repository after another**: with GitHub hanging, ten repositories at the client's 30 s timeout would hold the tick's lease renewal for the whole 5-minute lease.
- **Count an `unknown` repository of one's own as private**: a public pull request whose read failed would name its private siblings.
- **Leave a private sibling out of the section**: the public pull request would show a merge order with a gap, and its reviewer could not tell that another pull request comes first.
- **Rewrite a merged body when a visibility changes**: GitHub keeps a body's earlier edits, so the name would still be there.
