# 0216. A release blocker is done once its repository is released after its merge

Date: 2026-10-26 · Status: Accepted · Amends [0211](0211-the-intake-starts-ready-sub-orders-at-their-order-s-rank-once-their-blockers-merged.md) (a sub-order with a `release` blocker can be ready) and [0013](0013-single-repo-sub-orders-bottles-and-releases.md) (the release signal is a recorded `release.observed` of the blocker's repository, and the wait for it has no batch, outside Conditioning)

## Context
[ADR 0211](0211-the-intake-starts-ready-sub-orders-at-their-order-s-rank-once-their-blockers-merged.md) starts a sub-order once every sub-order it is blocked by has its pull request merged, but a sub-order with a `release` blocker is never ready there.
[ADR 0013](0013-single-repo-sub-orders-bottles-and-releases.md) has a `release` dependency wait until a configured release signal, a GitHub release or tag first, reports a new version of the blocker's library.
ADR 0211 left it out because the fold did not order a release against a merge: `State.releases` was a list, and neither `release.observed` nor `pull_request.ended` carries a time.
Nothing records a release yet: `release.observed` is in the schema, the fold and the stores, but no code appends one.
Nothing produces a sub-order yet either (mash, #388).

## Decision

### When a `release` blocker is done
- A `release` blocker is done when its pull request merged, as for `code` (a pull request of one of its batches, or of a bottle it is in), and a `release.observed` of its repository was folded after that merge.
- Its repository is the one its order's latest breakdown gives it (`SubOrderRef.repo`), compared with the release's in lower case, as `orderKey` compares repositories: GitHub's names are case-insensitive.
- A release folded before the merge does not count: it cannot hold the change. A later release does.
- A pull request ended `closed` is never done, released or not.
- A sub-order with both a `code` and a `release` blocker waits for both.

### How the fold orders them
- The fold gives each merge and each release a position, counted together, as `rank.seq` counts ranks: `State.merges` holds the position of each pull request's first recorded merge, by URL, and each `Release` its own `seq`.
- A release counts for a blocker when its position is after one of the blocker's merges.
- It is derived, not recorded: no event changes, and a replay of an old log gives the same positions and the same ready set.

### Package and version
- `Dependency` names no package and no version, so any release of the blocker's repository counts.
- Matching a package or a minimum version needs the breakdown to carry one, which mash (#388) can add later; not here.

### What records a release
- Nothing does yet, and this record builds on recorded `release.observed` events only, as ADR 0211 built on recorded breakdowns (the maintainer, 2026-10-26): with no producer of sub-orders, there is no `release` blocker to read a release for.
- The producer to come is the intake, reading the latest GitHub release or tag of each repository that has a merged, unreleased `release` blocker (ADR 0013), a follow-up issue of its own.

### The wait
- A sub-order waiting for a release has no batch, as one waiting for a `code` blocker's merge has (ADR 0211): it is in no lane, outside Conditioning, with no reminder, and the intake orders it in the first pass after the release is recorded.
- ADR 0013's "conditions until the release signal reports it" no longer holds for a sub-order: Conditioning stays the wait of a batch that has started (`batch.waiting`).
- It widens ADR 0211's exception to "every wait has a deadline": once the blocker's pull request merged, no open pull request shows the wait, which is for CI to publish and a release to be recorded.
  The blocker's batch stays On tap with its pull request merged, and the board (#240) is where the queue and what its sub-orders wait for will show; until a producer records releases, nothing ends this wait, as nothing produces such a sub-order either (What records a release).

### Not here
- The dependent's first step, bumping the dependency (ADR 0013), is its recipe's: nothing in this record starts it.

## Consequences
- A breakdown with `release` dependencies runs end to end once something records the releases.
- A release recorded before a merge, as when a repository releases on its own schedule, waits for the next one.
- Any release of the repository counts, even one of another package of a monorepository, until a breakdown names the package.
- The fold keeps one position per merged pull request: a map that grows with the merges, as `pullRequestEnds` does.

## Alternatives considered
- **Mark, on `release.observed`, the pull requests recorded merged so far in that repository as released.** Equivalent for one reading, but the fold would have to know each pull request's repository at the release, from its URL or its batch, while the ready set reads the blocker's repository from the breakdown; positions keep the question in the ready set.
- **Compare wall clocks.** Neither event carries a time, and two drivers' clocks differ.
- **Read the release's tag commit against the merge commit.** It answers whether the release holds the change, but it is a git read in what must be a pure function of the fold; the producer may read it before it records a release.
- **Match a package and a minimum version now.** The breakdown names neither, and `WaitCondition`'s `release` (with `package` and `minVersion`) is Conditioning's, for a started batch.
- **Condition a batch on the release (ADR 0013).** Rejected as in ADR 0211 for `code`: a batch from the breakdown on, for a wait the ready set already decides.
