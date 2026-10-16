# 0050. The intake of target-repository issues: aliases, recorded pull request ends and effect deadlines

Date: 2026-10-16 · Status: Accepted · Amends [0008](0008-polling-intake.md) (what the intake records), [0043](0043-target-repository-issues-as-a-work-queue-claimed-by-a-ref.md) (batch ids, the order of a target issue, the end of a pull request, the conditional delete) and [0044](0044-batch-leases-held-by-the-driver-and-one-command-log.md) (a deadline for every effect)

## Context
[ADR 0043](0043-target-repository-issues-as-a-work-queue-claimed-by-a-ref.md) made target-repository issues a work queue that Breweries claim by a ref, and left the wiring to #103. These questions were open:

- **The batch id of a target issue.** It becomes a folder on the state branch, so it must be a `PathSafeId` of at most 64 characters, and it must never collide with a Brewery issue's `<issue>-<n>`. A repository name can be 100 characters long, so the id cannot contain it.
- **Which repository an order's issue lives in.** `OrderRef` had only an issue number, and the fold keeps orders and sub-orders by that number, so a target issue 7 and Brewery issue 7 would be one order.
- **The end of a pull request.** The release, and Conditioning on `merge`, need the fact that a batch's pull request merged or closed. `claimEffectsDue` took the states as input, so whoever called it had to ask the code host. But every effect must be due because of recorded events (ADR 0033): a restarted engine has to find the same effects due.
- **The conditional delete.** ADR 0043 deletes the claim ref through GitHub's GraphQL `updateRefs` with `beforeOid`, and said nothing may rely on it until a test against GitHub proves it.
- **A slow effect.** The driver renews a batch lease before each effect, not during one ([ADR 0044](0044-batch-leases-held-by-the-driver-and-one-command-log.md)), so an effect slower than the lease lets a second driver take the batch and apply it too. #130 asked that the first real effect target get a deadline below the lease, pinned by a test.

The consultant's review of #124 proposed answers to the first four ([#103](https://github.com/EdwinBekaert/foedrum/issues/103#issuecomment-6220973833)).

## Decision

### An alias per polled repository, and batch ids `<alias>-<issue>`
- A repository in `foedrum.jsonc` that names an `intake` filter (`labels`, at least one, and optionally a `milestone`) must also name an **`alias`**: a lower-case letter, then lower-case letters and digits, at most 20 in all (`RepositoryAlias`, `src/schemas/ids.ts`). No two repositories share one. A repository without an intake may name an alias and needs none.
- The batch of a claimed issue is **`<alias>-<issue>`**, and `<alias>-<issue>-<n>` from 2 when the issue is ordered again (`targetBatchId`, `src/engine/batch-id.ts`). It starts with a letter, so it never begins a Brewery issue's id, which starts with a digit. The alias has no hyphen, so the issue that follows it is never ambiguous. At most 20 + 1 + 16 + 1 + 16 = 54 characters.
- `foedrum doctor` reads `foedrum.jsonc` in the working directory when there is one, and reports a config that does not pass its schema as a required problem: two repositories with one alias are refused there, with zod's reason on one line.

### The order of a target issue
- `OrderRef` gains an optional `repo` (`owner/name`): the repository a claimed issue lives in, absent for a Brewery issue. A batch keeps it (`Batch.repo`).
- A claimed target issue is an order (the glossary, ADR 0043), but not one of the Brewery's own issues, whose numbers its number would collide with. So the fold keeps its batch apart: it never joins the fold's `orders` or `subOrders`, which are keyed by Brewery issue number. It is never a sub-order (`parentBatchId` is refused), it is never decomposed (sub-orders are Brewery issues split from a Brewery order), and a rewind names only its own repository, as for a sub-order. `status`, `stuck` and `replay` name it `owner/name#<n>`.

### The end of a pull request is an event
- **`pull_request.ended { batchId, pullRequest, state: 'merged' | 'closed' }`** records that a pull request of the batch merged or closed. The guard accepts it only for a pull request the batch opened (its batch is on tap with it) or waits for (Conditioning on its merge), and the fold refuses a second end of the same pull request. A pull request reopened after its end stays ended: the release is final (ADR 0043).
- The intake records it when its poll sees the change. `claimEffects` reads the recorded ends (`Batch.pullRequestEnds`), and a pull request without one counts as open. Nothing asks the code host whether a pull request merged when deciding what is due.

### The intake pass
`createIntake` (`src/engine/intake.ts`) runs one pass at a time, in this order:
1. For every claimed batch on tap, it asks the tracker how each of its pull requests without a recorded end stands, and records a merge or a close.
2. While the Brewery has **free capacity**, it lists the open issues of each repository with an intake filter, in the order the config names them. It calls `claimCandidates` with the free capacity as its `limit`, and orders every claim won, or found as its own, as `<alias>-<issue>`. The order sets the batch's routing deadline (ADR 0032).

- The free capacity is the capacity less the batches that are Ordered or Brewing (`freeCapacity`). A Stuck or Conditioning batch waits for a person or another event and holds no place. The capacity is the Brewery's batch concurrency, the `concurrency` setting architecture §14 lists for `foedrum.jsonc`; until that field comes with the program that runs the intake, it is an option of the intake (`IntakeOptions.capacity`).
- The brewed issues of a repository, which `isCandidate` skips, are those of its batches in any lane, compared ignoring case.
- A repository the pass cannot list, or a pull request it cannot read, is reported, and the pass goes on. A claim the code host fails stops the claims in that repository (`ClaimPass.failed`); the claims won before it are ordered in the same pass, so none is left without a batch, which nothing would ever release.
- Passes never overlap: `poll` chains them, as the driver chains its effect passes. Two passes at once would both find the first one's claim as their own and order the issue twice.
- **A pass has a deadline**: at most half the default batch lease (2.5 min), and that by default (`IntakeOptions.deadlineMs`). Each request to GitHub ends at 30 s, but a pass makes many, so the pass needs a bound of its own: run inside a driver's tick, it must never hold off the heartbeat until the batch leases expire (ADR 0044, #130). At the deadline the pass is given up and reported, and its signal, which reaches the tracker and, through `claimCandidates`, the claim host, aborts. A pass that goes on after its deadline, because a call ignores its signal, records no pull request end and orders nothing; the next pass finds its claims as its own. `createIntake` refuses a bad deadline or capacity at once.
- What the intake reads goes through `TargetTracker`: the open issues of a target repository, which are the `Tracker`'s (architecture §3.1), and how a pull request of a batch stands, which is the `CodeHost`'s. On GitHub both are one API, and the intake needs only these two reads, so it takes one dependency; a Brewery whose tracker is not its code host splits it then. Its GitHub implementation, with conditional requests (ADR 0008), is a follow-up.

### The claim marks and the release are the driver's effects
- `claimEffects` (`src/engine/claim-effects.ts`) gives the driver the effects of every batch of a claimed issue: the marks, then the release, as `claimEffectsDue` decides from the batch's lane and the recorded ends. Each is applied through the ledger while the driver holds the batch's lease (ADR 0044).
- Each effect is found by its key before it is applied (ADR 0033). An assignee and a label are found by being there. The claim and release comments are found by a hidden marker with their key, in a comment by the Brewery's own identity only (`IssueMarks.findComment`). The release of the ref is found by the ref being gone. A comment id the code host answers must be a positive integer, or nothing is recorded.

### Every effect has a deadline below the batch lease
- `DriverEffects.deadlineMs` is how long one effect may take: whole milliseconds, at least 1 and below `leaseMs`, half the lease by default. `openDriver` refuses any other value and lets its lock go.
- At the deadline the driver gives the effect up and aborts its signal. `applyEffect` hands the signal to the target, and records nothing once it aborted. If the effect landed after all, the next pass finds it by its key. The GitHub client stops its request on that signal, and gives up any request after 30 s anyway.

### The claim on GitHub
- `createGitHubClient` (`src/github/client.ts`) makes REST and GraphQL requests with the Brewery's token over the built-in `fetch`. It gives up a request after 30 s, or an answer longer than 4 MiB, the process runner's limit (ADR 0035): a claim commit's message is whatever someone with push access wrote. It returns GitHub's answers unchecked; every caller checks the fields it uses (`src/schemas/github.ts`).
- `githubClaimHost` (`src/github/claims.ts`) creates the claim ref on a parentless commit of git's empty tree. A 422 "Reference already exists" means the ref exists. It reads the ref back with its commit's message, and deletes the ref through `updateRefs` with `beforeOid`, `afterOid` all zeros and `force: false`.
- **The conditional delete holds on GitHub** (Verification below), so ADR 0043's fast-forward fallback is not needed. GitHub answers a `beforeOid` that does not match with an opaque error, the same one it gives for a fault of its own. So when the update fails, the host reads the ref again: moved or gone is a lost race (`false`), and a ref still at the commit is a fault, which fails the effect for the next pass to retry.

## Consequences
- A Brewery can claim, order, mark and release target-repository issues end to end in the engine, against a fake GitHub. One test makes two Breweries poll one repository at once, and each issue is ordered exactly once.
- The real effect targets now have a deadline, and #130's third item is done. A target that ignores its signal can still finish its work after the deadline. Only the code host's own refusal or the key stops a second application then, which is the limit ADR 0033 already names.
- A config with an intake but no alias, or with an alias used twice, no longer loads. Repositories without an intake are unchanged.
- Not yet wired, and follow-ups of #103: the GitHub `TargetTracker` (issue listing with ETags, pull request states) and `IssueMarks`; the Brewery's own polling, labelled orders and routing (the rest of #103); the program that runs the intake and its capacity setting; `foedrum order <alias>#<n>`, which orders an issue again under `<alias>-<issue>-<n>`. The chaos case for the marks across a kill is #107.

## Alternatives considered
- **An alias on every repository**, as the consultant proposed: one handle for every repository from the start, but a config change for repositories the intake never polls, whose batches never use it. `foedrum order` will require an alias for the repository it orders in.
- **The repository name in the batch id, or a hash of it:** too long, or unreadable in `status` and on the state branch.
- **Keep asking the code host in `claimEffectsDue`:** no event, but the effects due would depend on what GitHub answers at that moment, and a restarted engine could decide differently from the run before it.
- **A deadline in each effect target:** each target would need its own care, and nothing would check that a new target has one. The driver holds every effect to one deadline and checks it against its own lease.
- **The fast-forward release of ADR 0043:** just as atomic, but it never deletes the ref, and every Brewery must read `released` as free. It is not needed, since the conditional delete holds.

## Verification
- On 2026-10-16, against `EdwinBekaert/foedrum`, by hand: a claim ref on a commit of the empty tree was created (a second create answered 422 "Reference already exists"). `updateRefs` with a `beforeOid` of another commit failed with "Something went wrong while executing your query", and the ref stayed. With the commit it pointed at, the ref was deleted.
- The same day, `test/integration/github-claims.test.ts` (opt-in: `FOEDRUM_GITHUB_TEST_REPO`, `FOEDRUM_GITHUB_TEST_TOKEN`) passed 4 of 4 through `githubClaimHost`. Of two racing claims one won and one was taken; the claim was found as ours; a delete from another commit was refused and left the ref; a release deleted it. No ref was left behind.
