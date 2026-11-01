# 0300. A public pull request names a sibling in a private repository by its place only

Date: 2026-11-01 · Status: Accepted · Amends [0292](0292-the-pull-requests-of-one-order-name-each-other-and-the-merge-order.md) (the sibling section of a public pull request names no repository it cannot tell is public)

## Context
Since [ADR 0292](0292-the-pull-requests-of-one-order-name-each-other-and-the-merge-order.md) each sub-order pull request's body starts with a section that names its siblings as `owner/name#n`.
For an order split across `acme/web` (public) and `acme/internal-billing` (private), the public pull request read `acme/internal-billing#12`.
GitHub hides that pull request's contents from outsiders, but the repository's name, and that it has a pull request of this change, is in a public body.
The maintainer accepted that for ADR 0292 as a known risk, to be closed by #746.
Foedrum read no target repository's visibility: only `foedrum init` reads the Brewery's repository (`src/github/brewery-repository.ts`).
GitHub's `GET /repos/{owner}/{repo}` answers `private` and, on newer answers, `visibility` (`public`, `private` or `internal`).

## Decision
- **The driver reads each target repository's visibility** that `foedrum.jsonc` lists, through `GET /repos/{owner}/{repo}`, once when it opens (`repositoryVisibilities`, `src/github/repository-visibility.ts`, read by `wireDriver`, so `serve`, `brew` (and with it `lauter`) and `resume` of a running batch read it alike).
  A repository is `public` only when the answer is 200, `private` is false and `visibility` is `public` or absent; `internal` is `private`; any other status, an answer of another shape, or a read that fails is `unknown`.
- **A repository whose visibility is `unknown` is read again before each tick**, at most once a tick, until GitHub answers it; one read `public` or `private` is not read again in that run.
  So an offline start or one failed read does not hide every sibling for a whole `serve`, which can run for days.
- **No event records it.** Visibility is the code host's fact, not Foedrum's state; `siblingSection` takes it as an argument (`VisibilityOf`) and stays a pure function, its digest stable within a run.
- **A sibling is named only in a public repository, unless this pull request's repository is private.**
  When this pull request's repository is `private`, every sibling is named as before.
  Otherwise (`public` or `unknown`) a sibling whose repository is not `public` is hidden: its line reads `<n>. A pull request in a private repository: <state>, <when>.`, and other lines refer to it as `pull request <n> (in a private repository)`, `<n>` its place in the merge order, so two hidden siblings stay apart.
  A `release` dependency on a hidden sibling reads `… merges and its repository has a release after it`.
  A hidden sibling that has no pull request yet is hidden the same way, its repository unnamed.
  An `unknown` sibling counts as private and an `unknown` pull request of one's own as public, so a name is never shown by mistake.
- **The order's status comment is unchanged**: it is in the private Brewery and names every pull request (`subOrderPullRequests`).

## Consequences
- A public pull request's body names no private repository of its order, nor the number of its pull request.
- **A visibility that changes between runs changes the section**, so its digest differs and `siblingEffects` writes a revision in the next run's first pass, while the pull request is open.
  A merged body is revised only when a sibling opened since, and a closed one never (ADR 0292), so a visibility change does not rewrite those: their edit history on GitHub keeps the old text anyway.
- A visibility that changes during a run is seen by that run only when it was `unknown`; otherwise the next run sees it.
- While GitHub cannot be read, each tick makes one more request per `unknown` repository.
- A body written before this record still names its private siblings until its next revision, or as it merged.

## Alternatives considered
- **Read visibility once per run only**: one failed read at the start would hide every sibling for as long as the run lasts.
- **Record visibility as an event**: it is GitHub's fact, and an event would make the store keep a copy that goes stale.
- **Count an `unknown` repository of one's own as private**: a public pull request whose read failed would name its private siblings.
- **Leave a private sibling out of the section**: the public pull request would show a merge order with a gap, and its reviewer could not tell that another pull request comes first.
- **Rewrite a merged body when a visibility changes**: GitHub keeps a body's earlier edits, so the name would still be there.
