# 0043. Target-repository issues as a work queue, claimed by a ref

Date: 2026-10-16 · Status: Accepted · Amends [0008](0008-polling-intake.md) (what the intake polls), [0013](0013-single-repo-sub-orders-bottles-and-releases.md) (target-repository issues as orders), [0024](0024-state-branch-layout-outbox-and-divergence.md) and [0033](0033-chaos-tests-effects-found-by-key-and-leases-at-start.md) (effects of a batch, and the claim outside the ledger) and [0029](0029-attempt-worktrees-layout-claims-and-repair.md) (branch names in a target repository) · Amended by [0048](0048-the-intake-of-target-repository-issues.md)

## Context
A target repository is often shared by a team, and every team member has a private Brewery with its own engine. Each Brewery should be able to take issues from that repository and brew them. So several Breweries compete for the same issues, and once one of them starts on an issue, no other Brewery, and no person, should start on it too.

The design so far does not allow this. Architecture §3.3 and [ADR 0013](0013-single-repo-sub-orders-bottles-and-releases.md) make target-repository issues a triage source, "never a work queue": Foedrum never assigns, labels or closes anything there, and every order is a Brewery issue. [ADR 0008](0008-polling-intake.md) polls the Brewery only.

Nor can anything a Brewery already has stop the others. [ADR 0011](0011-state-in-the-brewery-repository.md) keeps one active engine per Brewery by pushing to its state branch, but each Brewery has its own state branch: a claim recorded there is invisible to every other Brewery. The claim has to live in the target repository, and it has to be atomic between Breweries that may poll the same issue in the same second.

Two more things collide when Breweries share a repository: the branches they push (two Breweries' batch ids may be the same, since both count from their own issues, ADR 0029), and the effects they apply, which the ledger keys by an attempt ([ADR 0033](0033-chaos-tests-effects-found-by-key-and-leases-at-start.md)) while a claim's marks belong to a batch that has no attempt yet.

## Decision

### Target-repository issues are a work queue, where a Brewery asks for it
- A repository in `foedrum.jsonc` may name an **intake filter**: labels the issue must all have, and optionally a milestone. Its open issues that pass the filter are orders of this Brewery once claimed. The field in the configuration schema comes with the intake (#103); the core takes it as `IntakeFilter`. A repository without a filter is not polled for issues, so nothing changes for a Brewery that does not ask (the Infection check's triage, §3.3, stays as it is for repositories configured as triage sources).
- The intake polls those repositories as it polls the Brewery (ADR 0008: conditional requests, behind the `Tracker` interface). Everything it reads there is untrusted input.
- An order is then an issue in the Brewery **or a claimed issue of a target repository**. Orders made in the Brewery, and sub-orders, are private to it and are never claimed: nobody else can see or take them. Their pull requests land in the target repositories as before.
- An order of a target issue records its repository: `OrderRef` gains an optional `repo` (absent for a Brewery issue). The event change, the batch id of such an order (it must not collide with a Brewery issue's `<issue>-<n>`, and must stay a `PathSafeId`), and the intake itself are #103.

### What the intake picks
An issue is a **candidate** when all of these hold (`isCandidate`, `src/engine/issue-claims.ts`):

- it is an open issue, not a pull request;
- one of the Brewery's allow-listed users opened it (architecture §10: only allow-listed authors create orders). A target repository may be open to anyone, and a label is no boundary: an issue template can add one for any author. Before this ADR every order was a Brewery issue, which only its owners could open;
- it passes the repository's filter;
- it has no assignee, or every assignee is this Brewery's GitHub user (the identity of its token): an issue assigned to a person is that person's. That gives a simple team flow: assign an issue to yourself, and your Brewery picks it up;
- this Brewery has no batch of it, in any lane. A batch that was cancelled, or whose pull request was closed, is never brewed again by itself; a human orders it again.

The claim ref is not part of the candidate check: the claim finds it, atomically, and an issue that another Brewery claimed is skipped there.

A pass claims candidates **oldest first, only up to the Brewery's free capacity**: how many batches it can start now (`limit` of `claimCandidates`). The pass stops once it has ordered that many (won or ours). The rest stay unclaimed, so the next pass can take them, or another Brewery can. A candidate that another Brewery holds costs no capacity, so the pass moves on to the next one. Without the limit, a Brewery's first poll would claim every issue that passes the filter, and the team's other Breweries would get nothing until those batches ended. That would defeat the shared queue this ADR exists for.

### The claim: a git ref created through the API
- The claim of issue `<n>` is the ref **`refs/foedrum/claims/issues/<n>`** in the target repository, created with `POST /repos/{owner}/{repo}/git/refs`. Creating a ref that exists fails (422), so of any number of Breweries that try at the same moment, exactly one creates it. No lock, lease or second round trip is needed.
- The ref points at a commit with no parents and an empty tree, whose message is the **claim record**: `{"brewery":"<owner>/<name>","issue":<n>,"claimedAt":"<ISO time>"}` (`ClaimRecord`, `src/schemas/claim.ts`). It names the Brewery repository and nothing else: no host names, user names or paths. The GitHub identity that made the commit is the token's own.
- `claimIssue` (`src/engine/issue-claims.ts`) decides from what the code host answers:
  - the ref was created: **won**;
  - the ref exists and its record names this Brewery: **ours**. A run before created it and was killed before it ordered the batch, so the intake orders it now. The claim is found by its key, as an effect is (ADR 0033), and needs no ledger entry;
  - the ref exists and names another Brewery: **taken**, and the issue is skipped; so is a ref whose record cannot be read or does not pass the schema (taken by someone unknown, reported);
  - the ref was there when creating it and gone when reading it (released in between): taken for this poll; the next poll tries again.
- Only someone with push access can create a ref, so a record is trusted as far as push access is: it is still checked against its schema, and a ref nobody can read is never treated as this Brewery's.
- The claim comes first, then the order: the intake issues `order` only for a won or own claim. A crash between the two leaves a ref that names this Brewery, which the next poll finds (ours). A crash after the order and before the state branch push leaves an order the store has and the remote does not; the claim is still this Brewery's, so the next start pushes it (ADR 0024).
- **A second exception to the ledger.** Every external effect goes through the idempotency ledger, except the state branch's push (ADR 0024) and now the claim: its ledger entry would need a batch, and the batch is ordered only once the claim is won. The claim is idempotent without it: created at most once by the code host's own refusal, and found by its record. `batch.ordered` of the issue is its record in the Brewery.
- **Within one Brewery** the order is still pushed to the Brewery's own state branch at its boundary (ADR 0024), before the batch's first attempt, so a second engine of the same Brewery stops before any work (ADR 0011).

### The visible mark, through the ledger
Right after the order, the batch's **claim marks** are due, in this order: assign the issue to the Brewery's GitHub user (`claim.assignee`), add the label `foedrum:claimed` (`claim.label`), and post a **claim comment** that names the Brewery and the batch (`claim.comment`). The label marks the claim, not the lane: it stays while the batch is Stuck or Conditioning, next to the lane labels of architecture §8 (`foedrum:brewing`, `foedrum:stuck`, `foedrum:on-tap`). The claim and release comments are new comments of their own, not the order's status comment, which is edited in place (§8). They are for people: a teammate who looks at the issue sees that someone is on it, and the assignee is GitHub's own way of saying so. The claim itself is the ref; a mark that is missing changes nothing between Breweries.

- Each mark is an effect of the batch, applied through `applyEffect` and keyed by the batch and its name (below), so it is applied once across a crash: an assignee or a label is found by being there, the comment by the key in a hidden marker, from the Brewery's own identity only (ADR 0033).
- `claimEffectsDue` returns the marks while the batch is live, and the release once it is due, each with its key and what it does, for the GitHub layer to turn into an `EffectTarget`. The engine never decides by asking a model.

### Release, and no automatic takeover
- The claim is **released** when the batch ends: it is cancelled, or every pull request it opened is merged or closed. Then, in this order: the label is removed (`release.label`), a **release comment** says why the claim ended (`release.comment`), and the ref is deleted when its record still names this Brewery (`release.ref`, through `releaseClaim`, which leaves a ref that names another Brewery, or that it cannot read, alone; found when the ref is gone). The delete names the commit that was read and happens only while the ref still points at it, in one step on the code host (GitHub's GraphQL `updateRefs` takes the expected old commit as `beforeOid`), so a claim that another Brewery made after a release by hand stays. The ref goes last, so the issue is never claimable while this Brewery's marks are still on it.
- **The conditional delete is unproven.** (Proven on GitHub on 2026-10-16, so the fallback below is not used: [0048](0048-the-intake-of-target-repository-issues.md).) Before anything relies on it, the GitHub layer must prove that `updateRefs` with `beforeOid` deletes only while the ref points at that commit, against GitHub itself in an opt-in integration test. If it does not hold, the fallback is #103's fast-forward release, which is just as atomic over REST:
  - the ref is never deleted;
  - a release moves the ref, without force, to a child commit whose message says `released`;
  - a claim of a released ref moves it to a child of that commit the same way;
  - of two racing moves, the second is not a fast-forward and fails;
  - a ref whose record says `released` counts as free.

  `ClaimHost` hides which of the two is used.
- **A batch that went On Tap without a pull request** is released as having ended without one, never as merged. `batch.on_tap` requires a pull request, but the release does not rely on that.
- **A release is final.** The end of a pull request is recorded once (#103); a pull request that is reopened after the release does not restore the claim, its label or its ref. Claim the issue again by ordering it again.
- **The assignee stays.** On a merge it records who did the work; after a closed pull request or a cancel, the issue stays with that person until a human gives it to someone else. Removing it would hand the issue to the next Brewery that polls, which is the takeover this ADR rules out. So the release comment of every batch that was not merged (cancelled, a closed pull request, or no pull request) ends with "Unassign the issue to make it available again."
- The release is due because of recorded events, as every effect is (ADR 0033): `batch.cancelled`, or the end of each pull request. Foedrum does not record the end of a pull request yet; the event that does (the intake observing a merged or closed pull request, which Conditioning on `merge` needs too) comes with #103. Until then `claimEffectsDue` takes the states of the batch's pull requests as input.
- A claim whose Brewery went silent is **never taken over automatically**: two Breweries brewing one issue is the failure the claim prevents, and a silent Brewery may still be brewing. A human releases it, with a command of the Brewery that holds it, or by hand: delete the ref (`git push origin :refs/foedrum/claims/issues/<n>`), and unassign the issue. A Brewery whose own claim was deleted by hand carries on with its batch; it does not claim again.

### Effects of a batch
- An effect key is either an attempt's, `["batchId","stepId",attempt,"effect"]`, or, new, a batch's, `["batchId","effect"]`, for effects due because of the batch rather than one of its attempts: the claim marks and the release. The fold refuses a batch effect of a batch the log never ordered, as it refuses an attempt's effect of an attempt it never scheduled, and the state branch keeps it in its batch's `events.jsonl` like any other effect of the batch.
- One batch claims its issue at most once, so its keys are unique per issue too; a new batch of the same issue (a human ordered it again) gets new keys.

### Branches in a target repository carry the Brewery
- Every branch Foedrum pushes to a target repository is named `foedrum/<brewery>/<rest>` for the local branch `foedrum/<rest>`, where `<brewery>` is the Brewery repository as `<owner>.<name>` in lower case (the folder name rule of ADR 0029). Two Breweries never push the same branch, even for batches with the same id, and a Brewery-made order or sub-order needs no claim to keep its branches apart.
- Local branches keep their names (ADR 0029): one work root belongs to one Brewery (ADR 0037), and the cleanup reads the batch from the local name. Only the push maps the name (`remoteBranch`, `src/workspace/attempt-worktrees.ts`), and looking up an existing pull request by branch (ADR 0011) uses the remote name.

## Consequences
- A team can share a target repository between private Breweries: an issue is brewed by at most one Brewery, and a person who assigns an issue to themselves keeps every other Brewery off it.
- Foedrum now writes to target-repository issues: a ref, an assignee, a label and comments. It needs push access to the repository (which a team member has) for the ref; a token that cannot create refs cannot claim, and the intake reports that instead of brewing unclaimed.
- The Brewery's repository name (`<owner>/<name>`) becomes visible to everyone who can read the target repository: in the claim record, the claim and release comments and the pushed branch names. This is accepted: the assignee already shows the person, and a team wants to see which Brewery holds an issue. A team that keeps its Brewery names private should name them accordingly.
- Two Breweries that use the same GitHub login are one person's, as far as the claim can tell: after one releases an issue, the other sees it assigned to its own user and may claim it again. Running two Breweries on one repository with one login is not supported. Nothing can detect it, `foedrum doctor` included, so **each Brewery uses its own team member's token**.
- `refs/foedrum/claims/…` is visible to anyone who lists the repository's refs, and is not fetched by a default clone (it is outside `refs/heads` and `refs/tags`).
- An effect key has two forms. Code that takes an effect key's step or attempt narrows it first. The generated event sequences of the property tests apply effects of attempts only, so I4 and the fold's properties check batch effects through unit tests until the chaos case for the marks (#107) generates them.
- The intake (#103) wires the pieces: pick, claim, order, apply the marks; the GitHub layer implements `ClaimHost` and the effect targets with the keys defined here. The chaos case for the marks across a kill is #107.
- A Brewery that loses its store and its state branch keeps its claims in the target repository: the next poll finds them as its own and orders the batches again, which is what a lost Brewery should do.

## Alternatives considered
- **Assignee or label only:** visible and native, but not atomic: two Breweries that poll the same second both see no assignee, and both assign. GitHub keeps both assignees.
- **The first claim comment wins, by creation order:** works with comment access only, but the listing is only eventually consistent, so both Breweries may start before one sees the other's comment and backs off; and every Brewery has to read and agree on a winner.
- **A claim on the Brewery's own state branch:** atomic within the Brewery and already there, but no other Brewery can see it.
- **A shared claims repository or file, updated by compare-and-swap:** atomic too, but one more repository every team member must create, share and keep access to, and a conflict on every claim of the team instead of only on one issue.
- **A lightweight ref to an existing commit:** saves creating a commit, but nothing then says which Brewery holds the claim, so a Brewery killed after creating it could not tell its own claim from another's.
- **Take over a claim after a silence:** frees issues of a Brewery that died, but a slow or offline Brewery may still be brewing; deciding that is a human's job.
- **Prefix local branches with the Brewery as well:** one name everywhere, but every local branch name and the cleanup's batch parsing would change, for work roots that already belong to one Brewery.
