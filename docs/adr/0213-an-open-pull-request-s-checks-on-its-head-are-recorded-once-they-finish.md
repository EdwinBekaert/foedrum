# 0213. An open pull request's checks on its head are recorded once they finish

Date: 2026-10-26 · Status: Accepted · Amends [0198](0198-an-open-pull-request-is-merge-tree-checked-when-its-base-moves.md) (the intake's pass reads one more thing of an open pull request) and invariant I5 (a wait with no deadline, written down)

## Context
After a batch's pull request opens, Foedrum records whether it merged or closed (`pull_request.ended`) and how it merges with a base that moved (`pull_request.base_checked`, [ADR 0198](0198-an-open-pull-request-is-merge-tree-checked-when-its-base-moves.md), [ADR 0203](0203-an-open-pull-request-s-checks-run-on-its-merged-tree-when-its-base-moves.md), [ADR 0209](0209-a-check-that-fails-on-an-open-pull-request-s-merged-tree-is-posted-on-it.md)).
It never reads the checks GitHub runs on the pull request: nothing in Foedrum knows whether the pull request's own CI passed on its current head (#544, split from #274).
#546 will send a batch whose checks failed back to a fix step, and #551 will post "Ready to merge" only when every check on the head passed; both read what this records.

Four facts shaped it.
A check runs as long as the repository's CI takes, which Foedrum neither owns nor bounds: a queue of runners can hold it for hours.
The status comment is rendered from the folded state alone (ADR 0072), and events carry no time of their own.
Right after a push, GitHub may list no check at all for a few seconds, until the repository's workflows register theirs.
And a check's name, conclusion and link are written by whoever runs CI on the repository: untrusted input, as every answer GitHub gives (ADR 0050).

## Decision
- **What is read** (`recordChecks`, `src/engine/pr-checks.ts`, one call in the intake's pass right after `recordEnds` and before the base check): for every open pull request of a batch on tap that its ledger opened, not ended and its branch not pushed to by someone else, as `openOf` decides for the base check (now exported from `src/engine/base-check.ts`), its head commit as GitHub has it now (`GET /repos/{repo}/pulls/{n}`, `head.sha`), then every check on that head: the check runs (`GET /repos/{repo}/commits/{sha}/check-runs`, GitHub's latest run of each) and the commit statuses (`GET /repos/{repo}/commits/{sha}/status`, the latest of each context), each read page after page through gh's login ([ADR 0073](0073-github-only-through-gh-s-own-login.md)), conditional on the answer before ([ADR 0052](0052-github-reads-rate-limit-pauses-and-the-polling-interval.md)).
  - **Through a reader of its own** (`PullRequestCheckReader`, `IntakeOptions.checks`; GitHub's is `githubCheckReader`, `src/github/checks.ts`), optional as `bases` is: `serve` gives it; a pass without one reads no checks.
  - A head GitHub has that is not the commit Foedrum pushed is read too: until someone else's push is known (the base check's `branchMoved`), what GitHub says the pull request heads is what its checks ran on. What a batch then does with a person's head is #546's (ADR 0198 leaves it alone).
- **Two events at most each time a head is the pull request's, right after `pull_request.base_checked` in the union.**
  - **`pull_request.checks_pending`** (`pullRequest`, `head`, `since`): the first pass that sees a check on the head still running, or no check at all, records the time of that pass, the intake's clock. It is needed because the status comment says since when it waits, and is rendered from the state alone: the time must be in the log, and no event carries one. It is recorded once per head.
  - **`pull_request.checks_finished`** (`pullRequest`, `head`, `checks`, `more`): once every check on the head has finished, each check's `name`, `kind` (`check_run` or `status`), `conclusion` and `url` when it has an https one. It is recorded once per head.
  - **A head with no checks** is recorded as finished with none, but only by a pass after the one that recorded it pending: the first pass after a push may come before the repository's workflows registered theirs, and a pull request that is "Ready to merge" because its CI had not started yet is the mistake #551 must never make. A repository without CI waits one pass.
  - **A head already recorded finished is not read again**: only the pull request's head is read, and a conditional read that finds nothing new costs no rate limit (ADR 0052).
  - **A head that moved is read from the start**: a record names its head, the fold keeps each pull request's latest record (`Batch.pullRequestChecks`), and a record for another head never counts for the current one. The admission refuses a second pending or finished record of the same head, so it is recorded once even with two writers.
  - **At most 100 checks are kept**, failed first, then in GitHub's order; `more` counts the rest. A name longer than 200 characters is cut. A link that is not https is left out.
- **Failed and passed**: every check counts, not only the required ones. A check run's `failure`, `cancelled`, `timed_out`, `action_required`, `stale` and `startup_failure`, and a commit status's `failure` and `error`, count as failed; `success`, `neutral` and `skipped` as passed. A conclusion GitHub names that Foedrum does not know is recorded as `unknown` and counts as failed. A check run queued, in progress, waiting or requested, and a commit status `pending`, are running. The rule is one function (`checkPassed`, `src/engine/pr-checks.ts`), which #546 and #551 call.
- **No deadline: the engine waits as long as the checks run.** This is a written exception to "every wait has a deadline" (CLAUDE.md's engine rule, invariant I5), beside a person's pause ([ADR 0202](0202-pause-and-continue-hold-an-order-or-the-whole-brewery-at-its-next-convenient-point.md)) and a blocked sub-order (ADR 0211). The batch does not sit silently: it is On tap, its pull request is open for a person to read, and its status comment says it waits for the checks on `<sha>` since `<time>`. A deadline would have to be a guess at someone else's CI, and the batch would go Stuck for a delay nobody in Foedrum can act on.
- **What #546 and #551 read**: `Batch.pullRequestChecks[url]`, the latest record of each pull request, pending (its head and since when) or finished (its head and each check with its conclusion and link). #546 sends the batch back with the checks `checkPassed` refuses and their links; #551 says every check passed on this head when the record is finished, its head is the pull request's, and none failed.
- **Where it shows**: a line per pull request in the status comment's pull requests (`checkLines`, `src/engine/status-comment.ts`): it waits for the checks on `<sha>` since `<time>`; the checks passed on `<sha>`; or failed on `<sha>`, naming the first failing check with its link and how many failed; or that `<sha>` has no checks. `foedrum replay` lists both events, as it lists every event.
- **A read that fails is reported and skipped**, as `recordEnds` does, and tried again by the next pass. A pass given up at its deadline records nothing more.

## Consequences
- The status comment of a batch on tap says whether its pull request's CI passed on its head, and since when it waits while it runs.
- Two more events per head at most, and three more conditional reads per open pull request per pass; a head recorded finished costs one.
- A batch On tap whose checks never finish stays On tap, with the wait shown: no supervisor tick makes it Stuck.
- Nothing acts on a failure yet: #546 does.
- A repository's CI that registers its checks more than one pass after the push is read as having none on that head.

## Alternatives considered
- **One more read on `TargetTracker`**: every fake tracker and every caller of the intake would have to answer it, though only `serve` reads checks; an optional reader of its own keeps them as they are, as `bases` does.
- **A field on `pull_request.ended` or `pull_request.base_checked`**: each records another fact on another trigger (an end, a base's move); a check's finish is neither.
- **One event per pass while the checks run**: a log that grows by one event per pass for as long as a queue holds the runners; one pending record per head says the same.
- **"Since" from GitHub's `started_at`**: a check run has it, a commit status does not, and a check queued for an hour has none; it would still need an event to reach the status comment.
- **"Since" from the push**: true only for the first head, and not when the batch went on tap before this was built.
- **Required checks only**: reading branch protection needs an admin's scope on some repositories, and a check that is not required still says the change broke something (#274, 2026-10-26).
- **Record a head with no checks on the first pass**: the race with the workflows' registration would let #551 call a pull request ready before its CI ran.
- **A deadline for the checks**: see the decision; the maintainer chose none (#274, 2026-10-26).
