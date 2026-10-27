# 0226. A failing check on the merged tree sends its batch back to the fix step

Date: 2026-10-27 · Status: Accepted · Amends [0219](0219-a-failing-check-on-an-open-pull-request-sends-its-batch-back-to-a-fix-step.md) (a second cause of the route back), [0198](0198-an-open-pull-request-is-merge-tree-checked-when-its-base-moves.md) (a base check is of a head, and the batch no longer always stays On tap), [0203](0203-an-open-pull-request-s-checks-run-on-its-merged-tree-when-its-base-moves.md) (the run's record names its head), [0209](0209-a-check-that-fails-on-an-open-pull-request-s-merged-tree-is-posted-on-it.md) (the post's text, and when it is due), [0164](0164-a-batch-merges-its-base-before-its-last-check.md) (an attempt sent back by the merged tree merges the base at its start), [0225](0225-a-ready-pull-request-gets-a-merge-brief.md) (the brief reads the base checks of the head it briefs) and [0128](0128-an-attempt-a-route-schedules-gets-what-sent-it-back.md) (a fourth kind of route input)

## Context
Since [ADR 0219](0219-a-failing-check-on-an-open-pull-request-sends-its-batch-back-to-a-fix-step.md) a failing check on an open brewed pull request's head sends its batch back to a fix step, for bounded rounds.
A check that fails on the pull request's merged tree with a moved base ([ADR 0203](0203-an-open-pull-request-s-checks-run-on-its-merged-tree-when-its-base-moves.md)) is posted on it ([ADR 0209](0209-a-check-that-fails-on-an-open-pull-request-s-merged-tree-is-posted-on-it.md)), and the batch stays On tap until a person acts.
The maintainer decided on #274 (2026-10-26) that a pull request that is not ready means the work goes on, and split the merged tree's half off as #547; a conflict with the moved base goes along the same route after it (#574).

Four facts shaped it.
A base check names the pull request and the tip, not the head it merged: after a fix round pushed a new head, the old head's failure would read as the new head's, and the batch would be sent back for it again and again.
The failure exists only with the base: a brewer whose worktree starts at the pushed task tree, without the base, cannot reproduce it, and a fix written there may not build with the base.
The next pass checks the pull request again only once the base's tip moved since its last check, else since the base the batch's latest merge read ([ADR 0198](0198-an-open-pull-request-is-merge-tree-checked-when-its-base-moves.md)); a fix round's green merges the base again ([ADR 0164](0164-a-batch-merges-its-base-before-its-last-check.md)), so it reads the tip the round merged.
And a post is due only On tap today: a tick that sends the batch back before the driver posts would lose the post for good.

## Decision

### A base check is of a head
- **`pull_request.base_checked` gains `head`**, the commit merged with the tip: the pass writes the head of the latest push it checked (`checkBases`, `open.head`), the merged-check run the head it was handed (`MergedCheckDue.head`). It is optional in the schema, so old logs replay.
- **The pass's "only when it moved" reads the checks of the latest push's head** (`lastTip`): the latest check of the pull request on that head, else the base the batch's latest merge read. A fix round whose green merged the tip is not checked again until the base moves; a new tip is checked on the new head.
- **A check without `head`** (an older log's) counts for `lastTip`, for the merge brief and for the status line as a check of any head, as before, so an upgrade runs no extra checks and shows the same; it is never a cause of the route back.
- **The status line shows the checks of the current head** (`baseCheckLine`, given the latest push's commit): an older head's failure shows nothing, never as failing.
- **The merge brief reads the latest base check of the head** it briefs (`readyOf`, [ADR 0225](0225-a-ready-pull-request-gets-a-merge-brief.md)).

### The cause
- **`FixCause` is `{ kind: 'checks' }` or `{ kind: 'merged_check', tip }`.** `pullRequestProblem(state, batch)` (`src/engine/pull-request-fix.ts`) gives the first problem of the open pull request on the latest push's head, in this order: the latest base check of that head failed on the merged tree, then failed checks on the head (ADR 0219).
- **One cause per round.** A pull request failing both goes back for the merged tree first: one route input and one cause per round keep the rounds and the Stuck text plain, and the next round reads the head's checks again.
- **`unchecked` sends nothing**: the machine's fault, not the pull request's (ADR 0209). A conflict sends nothing yet (#574).
- **The supervisor issues it with its cause** (`fixCommand`); `decide` reads the problem again on the state it decides on and refuses any other pull request, head, cause or tip.
- **A person's skip settles the head for every cause** (`Batch.pullRequestLeft`, ADR 0219).

### The route
- **`ScheduleRoute`'s `pull_request` gains `cause: 'merged_check'` and `tip`**, both or neither, absent for the head's checks, so old logs replay.
- **Rounds are shared**: one `maxRounds` for the pull request, whatever sent it back (`roundsOf` counts every `pull_request` route of the action step).
- **The route input reads the base check of that pull request, head and tip** (`mergedCheckRouteOf`, `src/brewers/attempt-plan.ts`): `Pull request <url> merges cleanly with <branch> at <tip> but fails its checks there:`, the failed reading as a check step's route input shows it (`failedReading`), with its tail as recorded, already cut and read for secrets (ADR 0209, not filtered again), then that the base is merged into this worktree and the recipe's own checks run after the step. A check no longer there gives one line saying so.
- Its source is `why step <goto> runs again: the failed merged-tree check of pull request <url>`, untrusted, in the nonce tags, held to 64 KiB ([ADR 0128](0128-an-attempt-a-route-schedules-gets-what-sent-it-back.md)).

### The base merged at the fix step's start
- **An attempt that a merged-tree route scheduled merges the base before its brewer runs** (`routedMerge`, `src/engine/base-merge.ts`; gated in the driver's `mergeBase` beside `Recipe.mergesBase`): through the same effect, key and finding as ADR 0164, `["<batch>","<step>",<attempt>,"merge_base"]`. So does a retry of it (`retry: true`), which starts fresh as the attempt it retries did.
- **A conflict at that merge**, the base having moved again into one, ends the attempt `blocked` on a divergence, as ADR 0164's merge does; #574 changes that.
- **Green then merges again** and, with no newer base, finds nothing new (`{ base }`); `mergedBase` reads the start merge, so a Taster's change still starts at the base it brought in.

### Stuck
- **`pull_request_failed` gains an optional `cause`**: `{ kind: 'merged_check', branch, tip, check }`, `check` as the status line names it (`checkOf`), with `failed: []`.
- The status comment and `foedrum status` say the pull request fails its checks on the merged tree with `<branch>` at `<tip>` after its rounds: `<check>`.
- **`retry` sends it back along the route with the same cause**; `skip`, `rewind`, `recipe` and `cancel` as for the head's checks.

### The posts stay and say so
- **When the batch's recipe has the route, a failure's post says Foedrum sends the batch back to fix it** while its rounds last, at most `<maxRounds>` rounds in all, unless a person holds or skips it (the post is made once, before the rounds it names are known to run), and that its status comment says how it goes; without the route it keeps today's text. `baseConflictEffects` gets the recipes for it, and the recipe's `maxRounds` (`Recipe.maxRounds`).
- **A post is due On tap, and while the batch brews or is Stuck after a `pull_request` route on that pull request** (`sentBackFrom`), as `recordEnds` reads ended pull requests (ADR 0219): a tick that sends the batch back before the driver posts loses no post.
- A conflict's post keeps its text: it sends nothing back yet.

## Consequences
- A brewed pull request whose merged tree fails a check after its base moved gets up to `maxRounds` fixes pushed to its branch, each from an attempt with the base merged in that reads the failing check and its tail, then a Stuck batch that names it.
- A fixed head is never sent back for its old head's failure; the base is checked on it once the base moves past what its round merged.
- Three schemas move: `pull_request.base_checked`, `ScheduleRoute` and `StuckReason`; an older Foedrum cannot read a log that holds a check with `head`, a merged-tree route or its Stuck.
- A fix round costs one more fetch of the base at its start, a round trip with no objects on an unmoved base (ADR 0090).
- A head's failing checks wait one round behind a merged-tree failure on the same head.

## Alternatives considered
- **Keep base checks per pull request and drop them on a new push.** A fold rule that forgets recorded facts; the record of the head says it in the event that has it.
- **Both causes in one round.** One route input with two kinds of failure and a Stuck reason with both; the next round sees what is left either way.
- **Count the merged tree's rounds apart from the head's.** Twice the rounds a pull request can take, for no person's benefit: #547 asks for the same bounded rounds.
- **Merge the base in green only.** The brewer would fix a failure it cannot see, and its fix might not build with the base.
- **A recipe step that merges the base.** A step the loader adds changes the recipe's step ids and the status comment (ADR 0164).
- **Treat a check without `head` as of no head.** Every open pull request of an upgraded Brewery would be checked again at once, a run per pull request for nothing new.
- **Post only On tap, as before.** The send-back and the post race on the same state: a tick first would lose the post.
