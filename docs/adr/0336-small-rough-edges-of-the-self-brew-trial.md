# 0336. Five rough edges of the self-brew trial: a read's timeout, a lease's way on, a merge without a Cellar, a claimed issue's status and its recipe label

Date: 2026-11-06 · Status: Accepted · Amends [0052](0052-github-reads-rate-limit-pauses-and-the-polling-interval.md) (a read that timed out is tried once more), [0123](0123-foedrum-brew-drives-one-batch-under-an-owner-of-its-own.md) (what `foedrum brew` of an on-tap batch does, and what a lease's refusal says), [0198](0198-an-open-pull-request-is-merge-tree-checked-when-its-base-moves.md) (`foedrum brew` records the ends of its own batch's pull requests too), [0043](0043-target-repository-issues-as-a-work-queue-claimed-by-a-ref.md) (what the claim comment says), [0155](0155-a-claimed-order-s-brewery-issue-gets-the-status-comment-and-the-lane-label.md) (the target issue's comment says where the status is) and [0156](0156-a-claimed-order-is-routed-by-its-brewery-issue-s-recipe-label.md) (a line says that a recipe label on the target issue is not read)

## Context
The self-brew trial (#374) left five small things (#874):

- One `GitHub did not answer within 30000 ms` on a GET stopped `foedrum brew`, and the same read answered in under a second moments later.
- A lease's refusal named the driver and a time, and gave no way on.
- Only `foedrum serve` noticed a merge, so a person who only ran `foedrum brew` kept an open Brewery issue and a held claim until `serve` ran.
- A Stuck batch shows nothing on its claimed target issue.
- A `recipe:` label on the target issue is ignored, and nothing said so.

## Decision

### A read that timed out is tried once more
- **A GET whose `gh` timed out runs once more with the same arguments** (`exchange`, `src/github/client.ts`), so `rest('GET', …)`, `text` and every read above them get it.
- **A write never does:** it may have landed. That covers a GraphQL request, which is a POST and may be a mutation.
- **An answer is not a timeout:** a refusal, a 5xx and a rate limit are as they were.
- **A caller's signal wins.** A read given up by Ctrl+C or an effect's deadline is not tried again, and fails with the signal's reason, also when the timeout and the signal come at once.
- **A pause wins.** A read whose first try timed out while another request met the rate limit fails with `GitHubRateLimited` and does not ask again, so no retry hides or spends into a pause.
- A read that times out twice says `GitHub did not answer within 30000 ms, tried twice: GET …`.

This has an observed failure, the trial's, as `CLAUDE.md`'s rule on a new safeguard asks.
No layer below it retried: the process runner kills at the deadline and reports it.

**What a dead network costs.** A read with no answer takes 60 s instead of 30 s.
- A batch stops at its first failed effect, so a pass costs about 60 s per batch with effects due, where it cost about 30 s.
- An effect's deadline is half a lease, 150 s, so one read fits; the first failure ends the effect, so no second read follows it.
- The intake goes on after a failed read, so a pass reaches its own 150 s deadline after about 2.5 dead reads instead of 5. It reports the deadline, and what it did not reach waits for the next pass.
- The heartbeat runs before each effect, so a pass of many failing batches loses no lease.

### A lease's refusal says the way on
The line is now `batch 12-1 is driven by cellar until <time>, when its lease ends by itself; foedrum brew 12 --take takes it over now` (`drivenBy`, `src/cli/brew.ts`).
- It never says that driver stopped, which Foedrum cannot tell.
- It offers what the command can do, by the number ([ADR 0329](0329-one-number-per-piece-of-work.md)): `foedrum mash 12 --take` from a mash, and `foedrum resume 12 <step>` from a resume, which has no `--take` and takes a running batch over by itself.
- A lauter that loses its batch offers `foedrum brew 12 --take`, since the plan it corrected may no longer wait for a review.

### `foedrum brew` of an on-tap batch records its ends and applies what follows
- **A brew of an on-tap batch reads each of its pull requests with no recorded end**, records `pull_request.ended` for each that merged or closed, as the intake does (`recordEndsOf`, `src/engine/intake.ts`), and ticks until the driver lets the batch go, with the effects every driver applies: the release, the Brewery issue's close, the lane label and the status comment.
- It runs no intake. It reads only that batch's pull requests, and claims nothing else, as [ADR 0123](0123-foedrum-brew-drives-one-batch-under-an-owner-of-its-own.md) keeps it.
- The checks, the base checks and the releases stay with `foedrum serve`.
- So do the ends of the pull request a Brewing or Stuck batch brews a fix of ([ADR 0219](0219-a-failing-check-on-an-open-pull-request-sends-its-batch-back-to-a-fix-step.md)).
- **The refusals before it still hold:** a paused order, and a batch another driver holds unless `--take` takes it over. Nothing is read then.
- A read that fails ends the brew with its reason (exit 1), and nothing is released.
- A Cellar that records the same end first makes the second record a refusal of the fold, which changes nothing.

**How it ends:**

| The batch on tap | Exit | Its last line |
|---|---|---|
| Every pull request has ended, all merged | 0 | `batch web-7 merged: <urls>; Brewery issue #40 closed, claim on acme/web#7 released` |
| Every pull request has ended, one closed unmerged | 0 | `batch web-7 ended: <urls> not all merged; Brewery issue #40 stays open, claim on acme/web#7 released, unassign it to make it available` |
| A claimed batch with a pull request still open | 5 | `batch web-7 of #40 is on tap and holds its claim until its pull requests end: <urls>; foedrum brew 40 reads them again` |
| A Brewery issue's batch with a pull request still open | 5 | `batch 12-1 of #12 is on tap; foedrum order 12 orders it again`, as before, since that is open to it |
| A claimed batch whose release is still due, and no pull request left to read | 0 | as the first two rows, or `batch web-7 is on tap: no pull request` |

**Exit 0 where it was 5.** [ADR 0123](0123-foedrum-brew-drives-one-batch-under-an-owner-of-its-own.md) refused every issue whose latest batch ended.
A brew of an on-tap batch with a pull request that merged or closed now exits 0, and so does one whose release is still due.

**A release still due is finished.** A run killed after the end was recorded left a dead end: `brew` offered `foedrum order`, and `decide` refused that while the release was due.
So a claimed on-tap batch whose claim is `releasing` is driven too, one with no pull request included, which until now was refused.

**`foedrum mash` and `foedrum lauter` of an on-tap batch keep their own refusals** and read nothing: they are not what this is for.
A mash of a claimed batch whose claim is held no longer offers `foedrum order`, which `decide` refuses then, and names `foedrum brew` instead.

A brew that ends on tap with pull requests says what comes next, on the line before its last, which stays the pull requests' ([ADR 0261](0261-the-status-path-says-why-a-failed-attempt-failed-and-what-answered-a-question.md)): `once they merge, foedrum brew 40 or foedrum serve closes Brewery issue #40 and releases its claim`, without the claim for a Brewery issue's own batch.
`/foedrum:brew` shows a line that says the batch merged or ended as that, not as on tap.

### A claimed issue's status: one sentence, no new write
The target issue still gets no lane label and no status comment ([ADR 0155](0155-a-claimed-order-s-brewery-issue-gets-the-status-comment-and-the-lane-label.md)).
The claim comment gains one sentence: `Its status is on its order's issue in that Brewery, for those who can see it.`

- **It names no number.** `claim.comment` is applied before `order.issue`, on purpose ([ADR 0144](0144-a-claimed-target-issue-gets-a-brewery-issue-that-is-its-order.md)), so the number does not exist yet, and moving it after would leave the target issue with no comment whenever the Brewery refuses new issues. A bare `#19` there would also link to the target repository's own #19.
- **A person who can see the Brewery** has that sentence, and GitHub's link from the Brewery issue, which names the target issue, as ADR 0144 records.
- **A person outside the Brewery still cannot see the Stuck.** No comment text changes that: the lane is the private Brewery's business, which is ADR 0155's line.
- A comment already posted stays as it is, since the ledger skips an applied key.

### A recipe label on the target issue: said, not read
[ADR 0156](0156-a-claimed-order-is-routed-by-its-brewery-issue-s-recipe-label.md) stands: only people who can label in the Brewery choose a recipe, and copying the label would let anyone with triage on the target choose.
A brew that refuses a claimed issue for its Brewery issue's label says so first: `web#7 carries recipe:nip, which Foedrum does not read; label #19`.
The refusal stays the last line, as it was.

**The cost is one conditional GET of the target issue, on this refusal alone.** `GitHubReads` cannot look at its cache without asking, and the tick has just read the same path, so it is normally a 304. When that read fails, the line is left out and the refusal still prints.

## Migration
A Brewery has nothing to do, and no file changes. No event or schema changes.

## Consequences
- A person with no Cellar gets their Brewery issue closed and their claim released by brewing the number again after the merge.
- A brew of an on-tap batch costs one conditional GET per pull request with no recorded end.
- `foedrum brew` of an on-tap batch can exit 0 and change GitHub, where it used to refuse. A session reads the last line to tell which.
- `decide`'s refusal while a release is due still says `foedrum serve applies it`. It is still true, and `foedrum brew` applies it too; the words are left for #881.
- A cancelled claimed batch whose release is due still gets brew's refusal: only `foedrum serve` finishes it. That is left as it is.

## Alternatives considered
- **Run the intake in `foedrum brew`:** it would order and claim other issues, which [ADR 0123](0123-foedrum-brew-drives-one-batch-under-an-owner-of-its-own.md) refused.
- **Only say that `foedrum serve` closes it:** the line alone would leave a person with no Cellar needing to start one for a single read.
- **Retry every kind of failure:** a 5xx and a rate limit are answers, and repeated requests during a secondary limit can get the token blocked ([ADR 0052](0052-github-reads-rate-limit-pauses-and-the-polling-interval.md)).
- **Retry GraphQL queries too:** a read and a mutation look alike to the client, and a mutation that timed out may have landed.
- **A lane label on the target issue:** a new write on someone else's repository, needing a label to exist there, for a Brewery's business shown to outsiders.
- **Copy the target issue's `recipe:` label:** [ADR 0156](0156-a-claimed-order-is-routed-by-its-brewery-issue-s-recipe-label.md) refused it.
