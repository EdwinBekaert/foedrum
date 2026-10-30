# 0230. Open pull requests of one repository are merge-tree checked against each other

Date: 2026-10-30 · Status: Accepted · Amends [0198](0198-an-open-pull-request-is-merge-tree-checked-when-its-base-moves.md) (a second merge-tree, a head against another head) and [0225](0225-a-ready-pull-request-gets-a-merge-brief.md) (the brief's evidence names conflicts with the other open pull requests)

## Context
The base check ([ADR 0198](0198-an-open-pull-request-is-merge-tree-checked-when-its-base-moves.md)) merge-trees each open brewed pull request's head with its base's tip once the tip moves.
Two open pull requests that each merge cleanly with the base but conflict with each other are found only when the first merges, the base moves, and the base check runs on the second.
The merge brief ([ADR 0225](0225-a-ready-pull-request-gets-a-merge-brief.md)) left such conflicts out until several brewed pull requests are open at once (#274, 2026-10-26); the maintainer decided to build it now (#550, 2026-10-28).

Four facts shaped it.
`git merge-tree --write-tree` finds the merge base of its two commits itself, so it takes two heads as it takes a head and a tip, on every git Foedrum runs on ([ADR 0200](0200-foedrum-requires-git-2-38.md)).
The log names every open brewed pull request of the Brewery's own and the head its latest push recorded (`openOf`), with no GitHub read.
A conflict between two pull requests is symmetric: neither is wrong alone, and whichever merges first leaves the other with a conflict against its base.
The base check already sends a pull request whose base moved into a conflict back to its fix step ([ADR 0244](0244-a-conflict-with-the-moved-base-sends-its-batch-back-to-the-fix-step.md)).

## Decision

### Which pull requests
- **Only the Brewery's own open brewed pull requests** that `openOf` gives, of one repository: each base check repository has one base, so they share it. Other Breweries' pull requests on a shared target repository ([team model](../brewers-and-recipes.md)) and people's pull requests are left out: the log does not know them, reading them would be a GitHub read per pass, and each Brewery still finds such a conflict through its base check once the other merges.

### When a pair is checked
- **Once per pair of heads**: each intake pass, after `checkBases`, merge-trees two open heads of one repository that it has no record of (`checkPairs`, `src/engine/pull-request-pairs.ts`), through that repository's `BaseCheckRepository.mergeTree`, the clone the base check uses.
- **A new head of either** (a fix round, [ADR 0219](0219-a-failing-check-on-an-open-pull-request-sends-its-batch-back-to-a-fix-step.md), ADR 0244) is a new pair, checked once more; an unchanged pair is never checked again.
- **A head someone else pushed over is not checked**, as ADR 0198 has it: a pull request with a recorded `branchMoved` has no open head, and a pair whose bottle branch's remote tip is not the recorded head, or is gone, is passed over and records nothing (`BaseCheckRepository.branchTip`, read once per branch per pass, and only for a pair that is due).
- **A merge-tree that fails records nothing** and is reported through `failed`, as the base check's is; the next pass tries again.

### The record
- **A new event, `pull_request.pair_checked { batchId, pullRequest, head, other, otherHead, conflicts? }`**, recorded for each of the two batches, so each batch's fold has its own side: the files of a conflict, at most `MAX_CONFLICTS`, none when clean. The fold keeps the latest record per other pull request (`Batch.pairChecks`).
- **Each side is due on its own**: a pass killed between the two records checks the pair again and records only the side that lacks it, so each batch has each pair of heads at most once; the admission refuses a record of a pair of heads its batch already has.

### Ready is not held
- **A conflict between two open pull requests is shown, never holds "Ready to merge"** (`readyOf` unchanged; the maintainer's decision, 2026-10-28): holding both would leave neither ready, and whichever merges second gets the conflict from its base check once its base moves (ADR 0198) and goes to its fix step (ADR 0244).

### Where it shows
- **The brief's evidence** gains one line per other open pull request its head conflicts with, with the files, or "merges cleanly with the other open pull requests" when every other open pull request of its repository was checked clean against its current head; nothing when it is alone or a pair is not checked yet.
- **The status comment's pull requests** gain the same one line per conflicting pair.
- A record counts only while both heads are the ones its batches' latest pushes recorded and both pull requests are open: an ended or pushed-over pull request says nothing more.

## Consequences
- A Brewery with several open pull requests on one repository sees, within a pass, which of them conflict with each other and in which files, on each one's status comment.
- **A newly found pair conflict posts no new brief** (the maintainer's decision): the brief is posted per ready record, which a pair does not change; the status comment shows the conflict at once, and the brief's text says it at its next post, for a new head or new checks.
- n open pull requests of one repository cost n(n-1)/2 merge-trees once per pair of heads, and none again until a head changes, plus one remote read per bottle branch in a pass with a pair due. There is no cap: the open-order limit and each recipe's concurrency ([ADR 0217](0217-a-recipe-s-concurrency-and-the-open-order-limit-hold-what-the-intake-starts.md)) already bound n, and the base check has none either.
- One more event in the log; an older Foedrum cannot read a log that holds one.

## What this is not
- No comment on the pull request for a pair conflict, no fix route for it, and no merge order: a person sees both and chooses which to merge first.

## Alternatives considered
- **Every open pull request of the repository, read from GitHub.** Rejected: a GitHub read per pass and per repository, and a pull request Foedrum did not push has no head the log knows; the base check finds the conflict once it merges.
- **A field on `pull_request.base_checked`.** Rejected: a pair has no tip and no branch, and the base check's readers (`lastTip`, the posts, the fix route) would have to tell the two apart.
- **A ledger effect per pair.** Rejected: a merge-tree is a reading of the clone, not a side effect on GitHub; the log is where readings go (ADR 0213).
- **One record per pair, on either batch.** Rejected: the other batch's fold would not see it, and the status comment of each is rendered from its own batch.
- **A pair conflict holds Ready.** Rejected: symmetric, so neither of two conflicting pull requests would ever be ready, though merging either is fine.
- **A post on both pull requests.** Rejected: a comment on GitHub for a conflict that may never happen (either may close), and the status comment already says it.
- **Check every pair every pass.** Rejected: the answer for two unchanged heads cannot change.
