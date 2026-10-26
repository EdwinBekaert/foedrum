# 0219. A failing check on an open pull request sends its batch back to a fix step

Date: 2026-10-26 · Status: Accepted · Amends [0071](0071-the-openpullrequest-action-two-effects-of-the-batch.md) (one push per round, not per batch life), [0213](0213-an-open-pull-request-s-checks-on-its-head-are-recorded-once-they-finish.md) (what reads the record of the checks), [0198](0198-an-open-pull-request-is-merge-tree-checked-when-its-base-moves.md) (a bottle branch someone else pushed to is left alone at push time too), [0128](0128-an-attempt-a-route-schedules-gets-what-sent-it-back.md) (a third kind of route input), [0084](0084-a-batch-s-commits-end-in-a-pull-request-or-on-a-kept-branch.md) (the cleanup keeps one more branch) and [0025](0025-batch-lifecycle-stuck-reminders-and-rewind.md) (`step.scheduled` and `batch.stuck` from On tap, `pull_request.ended` while a fix brews)

## Context
Since [ADR 0213](0213-an-open-pull-request-s-checks-on-its-head-are-recorded-once-they-finish.md) the intake records the checks GitHub runs on an open brewed pull request's head, and the status comment says when they failed; the batch stays On tap and nothing acts on it.
The maintainer decided on #274 (2026-10-26) that a pull request that is not ready means the work goes on: a failing check on its head sends the batch back to a fix step with the failing output, the fix is pushed to the same pull request, its new head is watched again, and the rounds are bounded; when they run out the batch is Stuck with the failing output.
This is #546, the first of those problems; a conflict with a moved base or a failing check on the merged tree (#547) goes along the same route after it.

Six facts shaped it.
The latest record of a head's checks says how they stand now, not for good: a person re-runs a failed check and it passes (#546's comment).
The one push of a batch's life is the rule the ledger keeps today ([ADR 0071](0071-the-openpullrequest-action-two-effects-of-the-batch.md)): `["<batch>","push"]`, read by the base check, the status comment, the worktree cleanup and the action itself.
On tap is terminal today: the admission allows no step from it, and the cleanup of an On-tap batch deletes its attempt branches, the only ref to a pushed task tree in the clone.
A routed attempt starts fresh from the task tree ([ADR 0117](0117-a-retry-resumes-the-session-of-the-attempt-before-it-in-that-attempt-s-worktree.md)), and the last check step merges the base again on every attempt ([ADR 0164](0164-a-batch-merges-its-base-before-its-last-check.md)), so a fix round brings the base in.
A person may push to the bottle branch, merge or close the pull request at any time, also while a fix runs.
And a check's name, conclusion and link are written by whoever runs CI: untrusted input ([ADR 0050](0050-the-intake-of-target-repository-issues.md)).

## Decision

### The recipe says where a failure goes
- **`onPullRequestFail: { goto, maxRounds }`** on the `openPullRequest` action step only; on any other action the recipe is refused (`only the openPullRequest action has onPullRequestFail`). It is a route as `onFail` and `onBlocked` are: its `goto` names an earlier step at the same level or in an enclosing loop (`references`, `misplaced`, `src/schemas/recipe.ts`), never a parallel group (the loader's refusal, ADR 0168).
- Nip gets `{ "goto": "implement", "maxRounds": 2 }` (decided by the maintainer, 2026-10-26). A recipe without it keeps today's behaviour: the batch stays On tap with the failure shown.

### The supervisor notices
- **Each tick, for each batch On tap** (`fixCommand`, `src/engine/supervisor.ts`): its opened pull request with no recorded end, whose latest record (`Batch.pullRequestChecks[url]`) is finished, on the commit of the batch's latest push, with a check `checkPassed` refuses, no pause of its order or of the whole Brewery ([ADR 0202](0202-pause-and-continue-hold-an-order-or-the-whole-brewery-at-its-next-convenient-point.md); `pauseOf` passes over a batch On tap, so `fixHeld` reads the pauses itself), and whose recipe has the route, issues one engine command: `{ kind: 'fix_pull_request', batchId, pullRequest, head, cause: { kind: 'checks' } }`.
- **`decide` turns it into the route back or Stuck**, after checking the same facts again on the state it decides on; anything else refuses it. A record a re-run turned green is not finished-and-failed, so it sends nothing; a pending record sends nothing until it finishes.
- A paused batch is sent back once its pause is lifted: the next tick after `continue` sees the failed record.

### The batch goes back
- `decide` appends `step.scheduled` of the route's `goto` with `route: { from: <action step>, why: 'pull_request', pullRequest, head }`: a third `why`, and two fields only that `why` carries (`ScheduleRoute`, `src/schemas/events.ts`). The fold's existing case puts the batch in Brewing.
- **The admission allows `step.scheduled` from On tap only with such a route**, naming the batch's opened pull request, not ended; every other schedule from On tap is refused as before.
- The attempt starts fresh from the task tree, the pushed one, so its commits fast-forward the pull request's branch; the recipe's steps after it run as they would, the last check merges the base again (ADR 0164), and the action pushes again (below).
- **The cleanup keeps the task tree's branch of an On-tap batch whose pull request is open** (`Claims.open`, `src/workspace/attempt-worktrees.ts`): without it the fix round would have no tree to start from. One branch per open pull request; the other worktrees and branches of the batch go as before, and the kept branch goes at the next cleanup of the batch or the next repair once the pull request ended.

### The route input
- **From the record the route names** (`routeOf`, `src/brewers/attempt-plan.ts`): `Pull request <url> failed its checks on <head>:`, then each failed check's name, kind, conclusion and link, at most the record's 100, and how many more the record left out, then a fixed line that the brewer cannot open the links and that the recipe's checks run after it.
- No pass changes that record while the batch brews: the checks are read only of a batch On tap. A record that is no longer there, or of another head, gives one line saying so.
- Its source is `why step <goto> runs again: the failed checks of pull request <url>` (`src/brewers/prompt.ts`). It is untrusted, in the nonce tags, held to 64 KiB ([ADR 0128](0128-an-attempt-a-route-schedules-gets-what-sent-it-back.md)).

### Rounds and Stuck
- **Counted as every route** (`roundsOf`): the attempts of the `goto` whose `route.from` is the action step and whose `why` is `pull_request`.
- **When none is left**, the command makes the batch Stuck from On tap (the admission allows `batch.stuck` from On tap for this reason only) with a new reason `pull_request_failed`: the action step, the pull request, the head, the rounds used, the first 5 failed checks (name, conclusion, link) and how many more. So it does when the route's `goto` was skipped by its `when`: the engine runs no round there, and a divergence Stuck from On tap is not one the admission allows; a person's `retry` schedules that step all the same, as a person's retry names its step and schedules it without asking.
- Its options: `retry` sends the batch back along the route once more, a person's round past `maxRounds`; `skip` is the skip of the action step, so the batch goes On tap with its pull request as it is; `rewind` and `recipe` as from any Stuck step; `cancel`.
- **A skip settles that head**: the fold keeps the pull request and head of the `pull_request_failed` a `skip` resumed (`Batch.pullRequestLeft`, derived from the `batch.resumed` event and the lane it leaves, no event of its own), and nothing sends the batch back for that head again; otherwise the next tick would make it Stuck again at once. A new head is a person's push, which nothing sends back either.
- The action's own attempts are counted per round: `ACTION_ATTEMPTS` counts the attempts after the step's latest that succeeded, so a later round's action gets its three.

### One push per round
- **Round 1 keeps `["<batch>","push"]`**, so old logs replay; round n > 1 is `["<batch>","push.<n>"]`, n being 1 + the pull-request rounds taken, as the base check numbers its comments `base_conflict.<n>`.
- **`latestPush(state, batchId)`** (`src/engine/pull-request.ts`) is the push of the highest round recorded, and replaces every reader of the one push: the base check and the checks' `openOf`, the commits the state knows, the cleanup's unpushed task trees, the status comment's sensitive files and the action itself.
- **The action pushes the round's task tree** and opens nothing: the pull request's key is applied, and its body is not rendered again (#548). The push is the same as the first: the secret scan, the sensitive files, never forced, no hook (ADR 0071, [ADR 0079](0079-the-push-scans-the-batch-s-commits-for-secrets.md), [ADR 0201](0201-a-repository-names-its-sensitive-paths-and-a-batch-that-touches-one-says-so.md)).
- The refusal of a task tree that moved since the push stays for a move without a pull-request route (a rewind after the push): a round's push is keyed by its round, so a rewind after it still finds that push recorded with another revision.
- **A kill between the fix and the push pushes once**: the fix's end is in the log, so the next driver runs the remaining steps and the action; the round's key is not applied, so `find` reads the remote tip: at the new commit, a push a kill left unrecorded, recorded as found; otherwise it applies. A kill after the record and before the action's end ends the action with no second push.

### What a person does stays theirs
- **A head that is not the batch's push sends nothing**: a person's push to the bottle branch is a head the latest push never recorded, so its failure is theirs (ADR 0213 line 20, ADR 0198).
- **At push time the remote tip is read first** (round n > 1): at the commit of the round before, the round pushes; at anything else (a person pushed since the batch was sent back) or no branch (deleted after a merge), nothing is pushed and the round's `PushResult` records `moved: <sha>` or `gone: true`. The action ends, the batch goes On tap with its pull request, and `openOf` passes it over from then on: its checks are read no more and its base is checked no more.
- **A merge or close while the fix runs** is recorded: the intake's `recordEnds` also reads the opened pull request of a batch Brewing or Stuck after a pull-request route, and the admission allows that end (`endable`). The fix runs to its end; the action, seeing the end, pushes nothing, and the batch goes On tap, where the claim's release follows as today.

## Consequences
- A brewed pull request whose CI fails on Foedrum's head gets up to `maxRounds` fixes pushed to its branch, each from a fresh attempt that reads the failed checks, then a Stuck batch that names them.
- On tap stays terminal but for one way out: a batch On tap whose recipe has the route may go back to Brewing or Stuck on its pull request's failure. For the invariants (I1, I6), the claims and the cleanup it is still ended, except for the one kept branch: its wait on the pull request has no deadline, as ADR 0213 wrote down.
- The fold gains `Batch.pullRequestLeft`, derived from a skip; no event changes for it.
- The route input names the failed checks and their links, not their logs: the brewer cannot open the links, so a failure the recipe's own checks do not reproduce may take every round. Reading each failed Actions job's log tail, filtered as a check's tail is (`withoutSecrets`, [ADR 0088](0088-out-doc-text-that-looks-like-a-secret-is-left-out-of-the-pull-request-and-the-status-comment.md)), is #559.
- The recipe's own routes keep counting their rounds over the batch's life (ADR 0064): in Nip a `green` failure in a fix round, after `green` used its one round before the pull request, makes the batch Stuck (`attempts_exhausted`), and a person's `retry` goes on.
- The pull request's body is not rendered again on a push (#548), and no brief is posted (#551); a conflict or a failing merged-tree check does not send the batch back yet (#547), which adds a kind to `cause` and goes along the same route.
- Three schemas move: the recipe's action step, `ScheduleRoute` and `StuckReason`, and the ledger's `PushResult`; an older Foedrum cannot read a log that holds a `pull_request` route or a `pull_request_failed` Stuck.
- A fix round runs while the pull request is open, so a person who merges it meanwhile spends the round's tokens for nothing.

## Alternatives considered
- **`onFail` on the action**: the action's own failure, a push or open that fails, is retried by its attempts; one name with two meanings.
- **`onChecksFail`**: #547 sends conflicts and merged-tree failures along the same route; the field is named by the pull request, not the cause.
- **A recipe-level field**: every route is a step's, and the action is the step that opened the pull request.
- **The intake, right after `recordChecks`**: it has no recipes, so a batch whose recipe has no route would be refused on every pass.
- **`decide` on the record command**: the reading writer would decide a lane change, and a refused route would refuse the record.
- **Cut the fix short when a person merges**: a new abandon outside Stuck, for one round's cost; a follow-up if it shows up.
- **An On-tap batch with an open pull request counts as live for the cleanup**: every worktree of the batch would stay until the merge, for one branch the fix needs.
- **Start the fix from the pushed commit**: once its attempt branch is gone the commit is unreachable in the clone, and git's garbage collection may prune it.
- **Reset the recipe's other routes' rounds on each pull-request round**: a change to every route's count for a case `retry` covers.
- **One key per batch with the latest push's result overwritten**: the ledger records an effect once (ADR 0033); a second result under one key would be a second effect it cannot tell from the first.
