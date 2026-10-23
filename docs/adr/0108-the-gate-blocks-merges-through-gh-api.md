# 0108. The local gate blocks merges through gh api

Date: 2026-10-21 · Status: Accepted · Amends [0045](0045-the-local-gate-reads-commands-as-the-shells-would.md) (what the gate reads) and [0060](0060-the-gate-refuses-gh-pr-ready-without-the-review-summary.md) (the unreadable `gh api graphql` query) · Partly superseded by [0135](0135-the-gate-drops-the-check-on-gh-pr-create-the-graphql-readers-and-the-alias-rule.md)

## Context
The local gate always blocks `gh pr merge` ([ADR 0045](0045-the-local-gate-reads-commands-as-the-shells-would.md)): pull requests are merged by a maintainer, after CI and the review. `gh api` can merge as well, through the REST merge endpoint or GraphQL mutations, and the gate did not read those calls (#297). [ADR 0060](0060-the-gate-refuses-gh-pr-ready-without-the-review-summary.md) already blocks the `gh api` form of marking a pull request ready, and blocks a `gh api graphql` query the gate cannot read because it may be that mutation.

## Decision
- **The merge forms of `gh api` get the `gh pr merge` message.** These are blocked, not checked:
  - a `PUT` to a path or URL that ends in `pulls/<n>/merge` before any query string. The method is read as gh reads it: the last `-X` or `--method`, given as the next word, after `=`, joined to `-X`, or after `-i` in one group of short flags, in any case;
  - a query that names `mergePullRequest`, `enablePullRequestAutoMerge` or `enqueuePullRequest`, which merge a pull request, turn on its auto-merge or add it to the merge queue.
- **A `GET` passes.** `gh api …/pulls/<n>/merge` with no method, or with `GET`, only asks whether the pull request is merged.
- **What the gate cannot read is taken at its worst, as in ADR 0045.** A method computed at run time counts as `PUT`. A gh command group computed at run time is read both as `pr` and as `api`. A `gh api graphql` query from a file, `--input` or a variable stays blocked, now also because it may merge a pull request. An endpoint built at run time is blocked when its literal text still ends in `/pulls/<n>/merge` (`"$base/pulls/30/merge"`). An endpoint computed in full (`-X PUT $ep`) is not: ADR 0045 does not evaluate arguments.
- **Bash keeps `{name}` inside a word.** Bash treats a brace as reserved only when it is a word of its own, so gh's placeholders (`repos/{owner}/{repo}/pulls/30/merge`) are text inside one word. The reader used to split there, so it never saw the merge path. It now takes a `{name}` without spaces as text in bash. A brace group (`{ git push -f; }`) still splits. PowerShell turns `{…}` into a script block, and passes it to a native program as an encoded command (two of them fail with "The command parameter was already specified"), so gh never gets the path and its reading is unchanged.
- **Branch merges are out of scope.** `mergeBranch` and `POST repos/<owner>/<repo>/merges` merge one branch into another rather than a pull request. The ruleset on `main` refuses them there.

## Consequences
- A session can still ask whether a pull request is merged, and use every other `gh api` call it needs.
- Querying GitHub's GraphQL endpoint by path or URL (`/graphql`, `https://…/graphql`) with a query the gate cannot read is not yet blocked. This was already true of the ready mutation, and it is filed as its own issue.
- An endpoint computed in full can still merge. That would take intent, not an accident, and the ruleset on `main` is still the line that holds (ADR 0045).

## Alternatives considered
- **Check the merge like `gh pr ready`**, letting it through after the review: merging stays the maintainer's call whatever the review says, so there is nothing to check.
- **Block every `gh api` call that is not a `GET`:** simple, but sessions post comments and file issues with `gh api` (#48), and the review skill files issues that way.
- **Block a `PUT` whose endpoint is computed in full:** it would also block every computed `PUT` that does not merge (labels, reviewers). ADR 0045 already leaves computed arguments unread.
