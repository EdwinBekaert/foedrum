# 0292. The pull requests of one order name each other and the merge order

Date: 2026-10-31 · Status: Accepted · Amends [0013](0013-single-repo-sub-orders-bottles-and-releases.md) (how bottles of one order link to each other), [0227](0227-a-later-round-renders-the-pull-request-s-body-again-unless-someone-edited-it.md) (a body is also written again when its siblings change), [0167](0167-a-brewed-pull-request-follows-one-layout-and-opens-as-a-draft-unless-every-taster-approves.md) (a sub-order's body starts with the sibling section) and [0285](0285-an-approved-plan-becomes-brewery-sub-issues-through-the-ledger.md) (the order's status comment lists the sub-orders' pull requests)

## Context
[ADR 0013](0013-single-repo-sub-orders-bottles-and-releases.md) says the bottles of one order link to each other with a suggested merge order, and nothing built it.
Since [ADR 0285](0285-an-approved-plan-becomes-brewery-sub-issues-through-the-ledger.md) an approved plan becomes Brewery sub-issues, and each sub-order brews a batch and a pull request of its own, in its own repository.
Each of those pull requests stood alone, and the order's status comment named the sub-issues but not their pull requests.
M2's exit test asks for an order across two repositories that "ends with two linked PRs and the version bump".

Four facts shaped it.
The target repositories may be public, and the Brewery is private: the maintainer decided on 2026-10-31 that a pull request's body names sibling pull requests only, never the Brewery's issues or the Brewery.
A batch is on tap once its pull request opened, so the openPullRequest action's effects ([ADR 0071](0071-the-openpullrequest-action-two-effects-of-the-batch.md)) are no longer due when a sibling opens or merges later.
A person may edit a body at any time, and that edit is theirs to keep ([ADR 0227](0227-a-later-round-renders-the-pull-request-s-body-again-unless-someone-edited-it.md)).
The plan's dependencies (`code` and `release`, [ADR 0216](0216-a-release-blocker-is-done-once-its-repository-is-released-after-its-merge.md)) say which pull request has to merge before which.

## Decision

### The section
- **Each sub-order pull request's body starts with `## Pull requests of this order`**, when its order's latest breakdown keeps two sub-orders or more (`siblingSection`, `src/engine/sibling-pull-requests.ts`).
  It lists each sub-order that is not cancelled, in merge order, with its pull request as `owner/name#n` (GitHub links it and adds it to the other pull request's timeline), or its repository and `not opened yet`.
  It also gives the pull request's state (open, merged, closed without merging) and when to merge it: `merge after <ref> merges` for a `code` dependency, `merge after <ref> merges and <repo> has a release after it` for a `release` one, `merge first (<ref> waits for its merge|release)` for one others wait for, or `merge in any order`.
  The batch's own line says `(this pull request)`.
- **A sub-order's pull request** is the one the ledger opened for the latest of its batches that opened one; its state is that batch's recorded end of it.
- **The merge order follows the plan's dependencies**: a sub-order comes after every sub-order it is blocked by, and otherwise in the plan's order (a cycle, which a plan cannot hold, places the rest in the plan's order).
- **It names sibling pull requests only.** No sub-issue number, no order number and no Brewery repository is in the section.
  The body's existing `Brewed by Foedrum from …` and `Closes …` lines, which name the Brewery's sub-issue, are #741's to change.
- The section is first, before how it works, and ends with the line `<!-- foedrum:siblings -->`, so a revision finds it whole.
  It keeps to 8,000 characters, whole lines, counting the rest; every body keeps that room under GitHub's limit (`MAX_SIBLINGS`), so a later revision always fits.

### When it is written
- **The open and every later round render it** with the body from the state at `due` (`pullRequestText` given `siblings`).
- **Revisions of it are effects of their own**, `["<batch>","siblings.<n>"]` (`siblingEffects`), due for a batch whose pull request is open with no recorded end when the section's digest differs from the latest revision's.
  So a sibling that opens, merges or closes makes every other open sibling's revision due in the next pass.
- **`find`** reads the body: when it is Foedrum's own (`bodyOwner`, ADR 0227) and starts with this section already, the revision is recorded, the open's or a round's or one a run before wrote and was killed before it recorded.
- **`apply`** reads the body again: when it is Foedrum's own, its section is replaced (or put first, when it has none) and the rest kept byte for byte, ending with this key's marker, through `PATCH` with the body only; any other body is left as it is.
- **Its result** (`SiblingResult`, `src/schemas/store.ts`) is `{ section }`, the section's digest, with `left: 'edited' | 'unmarked'` when it left the body, so a body a person edited is not read again until the section changes.

### The order's status comment
- **Under the On tap line of the order's batch, once it is split**, one line per sub-order in merge order: `- #<sub-issue> in <repo>: <pull request>, <state>`, or `no pull request yet` (`renderStatus`).
  The Brewery's own comment may name its sub-issues.

## Consequences
- A reviewer of either pull request sees the other and which one to merge first, and GitHub links them both ways.
- A merge or a close of one pull request writes each other open one's body once, in the next pass after the end is recorded; a merged pull request's body is not written again, since it is its merge commit's description.
- **A person's edit in the one request between the read and the update is lost**, as with ADR 0227: GitHub has no conditional update.
- A body a person edited never gets the section again from that batch, and the status comment of the order still names every pull request.
- No schema with a JSON file moves: the ledger's results are not in `schemas/`.
- An order with one sub-order and a batch of a plain order get no section and no revision.

## Alternatives considered
- **A new body round (`body.<n>`) when a sibling changes**: the openPullRequest action is over once the batch is on tap, so no action effect would be due; and a round renders the reports again from the state at apply, which a sibling's change does not touch.
- **Render the whole body again on each revision**: it reads the order's title again and could change the reports' text between rounds; replacing the section alone changes only what changed.
- **A comment on each pull request instead of a body section**: the merge commit would not carry it, and a comment per sibling change is noise.
- **Name the Brewery issue in the section**: the maintainer's decision; a public repository would link a private one.
- **The section at the end, above `Closes`**: model text before it, inside a fence, could hold its end line; first, nothing precedes it but the engine's own text.
