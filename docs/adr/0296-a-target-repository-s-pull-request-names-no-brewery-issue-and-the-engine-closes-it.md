# 0296. A target repository's pull request names no Brewery issue, and the engine closes it

Date: 2026-11-01 · Status: Accepted · Amends [0071](0071-the-openpullrequest-action-two-effects-of-the-batch.md) (the body no longer closes a Brewery issue), [0167](0167-a-brewed-pull-request-follows-one-layout-and-opens-as-a-draft-unless-every-taster-approves.md) (how it was brewed names the recipe only, and `Closes` is a claimed issue's alone) and [0285](0285-an-approved-plan-becomes-brewery-sub-issues-through-the-ledger.md) (a sub-issue closes once its batch's pull request merged)

## Context
A Brewery batch's pull request named its Brewery issue twice: `Brewed by Foedrum from <brewery>#<n>` under How this was brewed, and a last line `Closes <brewery>#<n>` ([ADR 0071](0071-the-openpullrequest-action-two-effects-of-the-batch.md), [ADR 0167](0167-a-brewed-pull-request-follows-one-layout-and-opens-as-a-draft-unless-every-taster-approves.md)).
The pull request is in a target repository, which may be public; the Brewery is private, so outsiders saw its name and a dead link.
The maintainer decided on 2026-10-31 (#737) that a target repository's pull request body never links a Brewery issue; [ADR 0292](0292-the-pull-requests-of-one-order-name-each-other-and-the-merge-order.md) left these two lines to #741.
The `Closes` line also did work: when the pull request merged, GitHub closed the Brewery issue, a sub-issue of a split order ([ADR 0285](0285-an-approved-plan-becomes-brewery-sub-issues-through-the-ledger.md)) or an order never split.
A claimed target issue's batch ([ADR 0144](0144-a-claimed-target-issue-gets-a-brewery-issue-that-is-its-order.md)) closes the target issue, which is public, and its Brewery issue closes with the claim's release (`release.order`).

## Decision
- **A batch of a Brewery issue writes no Brewery issue in its pull request**: How this was brewed says `Brewed by Foedrum with the recipe <name>.`, and the body has no `Closes` line (`pullRequestText` without `closes`, `src/engine/pull-request.ts`).
  An empty title, which an issue cannot have, falls back to `Brewed by Foedrum`.
- **A claimed batch reads as before**: `Brewed by Foedrum from <target>#<n> …` and `Closes <target>#<n>`.
- **The engine closes the Brewery issue** once every pull request its batch opened has a recorded end and all of them merged (`pull_request.ended`, which the intake records for every batch on tap, [ADR 0198](0198-an-open-pull-request-is-merge-tree-checked-when-its-base-moves.md)): two effects of the batch through the ledger (`breweryCloseEffects`, `src/engine/brewery-closes.ts`), in this order:
  - `["<batch>","close.comment"]` comments on the Brewery issue `Merged as <owner/name>#<n>; Foedrum closes this issue.`, naming each pull request, with the key's hidden marker, so it is found by its key in a comment of the Brewery's own login;
  - `["<batch>","close.issue"]` closes it, found when it is closed already.
- **A Brewery issue a person deleted** ends both effects as `gone`, never a failure, as the claim's release does; one that is closed already gets no comment (`close.comment` recorded as `closed`), and its close is found.
- **A pull request closed without merging leaves the issue open**, also when the batch's other pull request merged: the work is not done, and a person decides.
- **Neither a claimed batch nor a split order's own batch is closed here**: the claimed one closes with its release, and the split order's batch opens no pull request; its close once every sub-order merged is #738's, on this same source.
- The comment on the Brewery issue may link the target pull request: a private issue naming a public pull request, never the other way.

## Consequences
- A target repository's pull request shows nothing of the Brewery, except a claimed issue's own `Closes`, and the sibling section's pull requests ([ADR 0292](0292-the-pull-requests-of-one-order-name-each-other-and-the-merge-order.md)).
- The Brewery issue closes in the pass after the intake records the merge, not at the merge itself, and only while a driver runs: `foedrum serve`, whose driver has the effect.
- A pull request into the Brewery repository itself, which a `Closes` line could have closed, closes its issue the same way, so there is one close path for every batch of a Brewery issue.
- A Brewery issue already closed when its close comes due gets no comment, and its close is found: a pull request that merged before this record with its `Closes` line closed its issue then, so a driver's first pass after the upgrade writes nothing on those issues.
- GitHub's link from the Brewery issue to the pull request that closed it is gone; the closing comment names it instead.

## Alternatives considered
- **Keep `Closes` and hide only the `Brewed by` line**: the `Closes` line is a link too, and GitHub shows it to every reader of the body.
- **Close the issue without a comment**: the issue would no longer say which pull request did its work.
- **Close it in the intake when it records the merge**: the intake records events; side effects go through the driver's ledger ([ADR 0033](0033-chaos-tests-effects-found-by-key-and-leases-at-start.md)).
