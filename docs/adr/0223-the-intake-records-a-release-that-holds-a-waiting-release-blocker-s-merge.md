# 0223. The intake records a release that holds a waiting release blocker's merge

Date: 2026-10-26 · Status: Accepted · Amends [0216](0216-a-release-blocker-is-done-once-its-repository-is-released-after-its-merge.md) (what records a release, and that a release is recorded only when it holds the merges it waits for) and [0013](0013-single-repo-sub-orders-bottles-and-releases.md) (the release signal: nothing to configure, read through gh for every repository with a waiting blocker)

## Context
[ADR 0216](0216-a-release-blocker-is-done-once-its-repository-is-released-after-its-merge.md) makes a `release` blocker done once a `release.observed` of its repository is folded after its merge, and leaves the producer of that event to come: "the intake, reading the latest GitHub release or tag of each repository that has a merged, unreleased `release` blocker".
Until then only tests write one, so a sub-order with a `release` blocker never starts outside a test (#558).
[ADR 0013](0013-single-repo-sub-orders-bottles-and-releases.md) speaks of a release signal configured per repository, GitHub release or tag first and package registries later.

Four facts shaped it.
A sub-order's repository comes from a breakdown (`SubOrderRef.repo`), not from the Brewery's configuration: it need not be one that `foedrum.jsonc` names.
The fold orders a release after a merge by when each was recorded, not by what the release holds, and the first read after a merge finds whatever release the repository had then: one published long before the merge would be recorded after it, and count.
A blocker's repository may release several times while a sub-order waits, or not at all, only tagging.
And what GitHub answers is untrusted input ([ADR 0050](0050-the-intake-of-target-repository-issues.md)): a tag's name is written by whoever can push to the repository.

## Decision

### Which repositories are read
- `releaseWaits(state)` (`src/engine/ready-set.ts`, beside `readySubOrders`) gives each repository with a waiting blocker: for each order's latest breakdown, each `release` dependency whose sub-order has no batch, whose blocker has a merged pull request and is not done, grouped by the blocker's repository in lower case, with each waiting blocker's merged pull requests by URL (`mergedOf`, the walk `mergesOf` makes, by URL).
- An order whose latest batch was cancelled is passed over; a paused or stopped one is read: a recorded release is a fact, and its sub-order starts as soon as the hold lifts.
- A Brewery with no such dependency makes no new request.
- Nothing is configured: every repository with a waiting blocker is read through gh's login ([ADR 0073](0073-github-only-through-gh-s-own-login.md)), and a repository gh cannot read fails the read, which is reported.

### What is read
- Through a reader of its own (`ReleaseReader`, `IntakeOptions.releases`, `src/engine/releases.ts`; GitHub's is `githubReleaseReader`, `src/github/releases.ts`), optional as `checks` is ([ADR 0213](0213-an-open-pull-request-s-checks-on-its-head-are-recorded-once-they-finish.md)): `serve` gives it; a pass without one records no release.
- **The latest release**: `GET /repos/{repo}/releases/latest`, GitHub's latest published release, never a draft or a prerelease, conditional on the answer before ([ADR 0052](0052-github-reads-rate-limit-pauses-and-the-polling-interval.md)): its tag's name and `published_at`.
- **Else the latest tag**: on that read's 404, the newest tag by its commit's date through GraphQL (`refs(refPrefix: "refs/tags/", first: 1, orderBy: {field: TAG_COMMIT_DATE, direction: DESC})`), since REST's tag list promises no order: its name and its commit's `committedDate`. A repository with neither has no release.
- **Whether it holds a merge**: the pull request's `merged_at` and `merge_commit_sha` (`GET /repos/{repo}/pulls/{n}`, conditional), then, only when the release's date is not before `merged_at`, `GET /repos/{repo}/compare/{tag}...{merge}`, conditional: `behind` or `identical` holds it, `ahead` and `diverged` do not. A pull request of another repository than the blocker's, or with no merge commit, holds nothing.
- Every field is checked; a tag whose name is no valid ref name (git's `check-ref-format` rules) or is longer than 255 characters is refused, and the report says why.

### When a release is recorded
- A pass reads each repository of `releaseWaits` in turn: its latest release; nothing more when it has none, or when the fold already holds that version of that repository (in lower case); else, for each waiting blocker, whether the release holds one of its merged pull requests.
- It records the release only when it holds a merge of **every** waiting blocker of that repository: the fold cannot say which merges a release holds, and a release recorded for one blocker counts for every blocker of that repository merged before it, including one whose merge came after the tag. A blocker merged after the tag holds the release back until a later release holds both.
- `release.observed`: `repo` as the breakdown spells it, `version` the tag's name, `package` the repository's name (ADR 0216: no package is known; one name for every release of the repository).
- Once per version: the admission refuses a `release.observed` whose repository (in lower case) and version the fold already holds, so two writers record it once.
- One notice when a release is recorded (`released`, with `repo` and `version`).

### Where in the pass
- After the base check and before the queue, so a release recorded in a pass starts its sub-order in that same pass, under `pause --all` too: it records, it orders nothing ([ADR 0202](0202-pause-and-continue-hold-an-order-or-the-whole-brewery-at-its-next-convenient-point.md)).
- A failed read is reported (`failed`, as `recordEnds` reports one) and the next repository is read; the next pass tries again. A pass given up at its deadline records nothing more.

### What this is not
- No package and no minimum version (#388 may add them to the breakdown), no package registry, no bump step (the dependent's recipe, ADR 0216), and no producer of sub-orders (mash, #388).

## Consequences
- A sub-order with a `release` blocker starts in the first pass after its repository publishes a release that holds the blocker's merge.
- A repository with a waiting blocker costs one conditional read per pass, its pull requests' conditional reads, and one compare per new release; a repository without releases one GraphQL query per pass, which counts against the rate limit.
- A release published before the merge, or cut from a commit that does not hold it, is never recorded: the sub-order waits for one that does.
- Two blockers in one repository, one merged after the latest tag, both wait for a release that holds both: a released blocker's dependent waits for a release that also holds a later blocker's merge, the price of never starting a dependent without its blocker's change.
- A tag whose commit date is set before the merge is never compared: its sub-order waits for the next release, never starts early.

## Alternatives considered
- **A release signal configured per repository (ADR 0013).** A sub-order's repository need not be in the Brewery's configuration, and there is nothing to configure for GitHub's releases; registries stay later.
- **Record the release when it holds one waiting blocker's merge.** It would count for every blocker of the repository merged before it, one whose change it does not hold too, and start its dependent against a version without the change.
- **Record which merges a release holds** (the pull requests it was compared with, in the event or beside it). Each blocker's dependent would start as soon as its own merge is released, but the fold and the ready set would change (ADR 0216 counts a release by its position, for every merge before it), and an old log's releases would hold nothing; the wait it saves is one release.
- **The times alone.** A release cut from an older commit after the merge would count.
- **The compare alone.** One more read per pass for every release older than the merge, and the compare of an old release lists every commit since: over the client's 4 MiB, it would fail the read.
- **REST's tag list for a repository without releases.** It promises no order, so its first tag need not be the newest.
- **A new event that carries the tag's commit.** The fold needs no more than it has: whether the release holds the merge is decided before it is recorded.
- **Read every repository of every breakdown.** A Brewery with release dependencies that all started, or none, would make requests for nothing.
