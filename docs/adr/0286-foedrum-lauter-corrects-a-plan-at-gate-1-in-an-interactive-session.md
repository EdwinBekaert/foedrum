# 0286. `foedrum lauter` corrects a plan at gate 1 in an interactive session

Date: 2026-10-31 · Status: Accepted · Amends [0275](0275-a-finished-plan-waits-stuck-for-its-review-and-every-comment-links-the-doc-it-sums-up.md) (`plan_review` offers `lauter`, and the next step names it), [0281](0281-foedrum-approve-signs-off-a-plan-by-its-hash-and-puts-the-batch-on-tap.md) (`approve` after a lauter signs off the session's plan), [0222](0222-a-recipe-s-brewer-step-may-be-interactive.md) (an interactive step a person's choice schedules, and a driver that opens it from a command), [0234](0234-the-brewmaster-writes-a-plan-on-the-planner-alias-and-mash-runs-it.md) (`mash` has a second step, and the Brewmaster corrects a plan it is given), [0059](0059-attempt-plans-from-the-brewer-of-the-step.md) (a brewer input from the batch's latest plan) and [0025](0025-batch-lifecycle-stuck-reminders-and-rewind.md) (the guard before append admits a lauter from Stuck `plan_review` by its reason, not its options)

## Context
Since ADR 0275 and ADR 0281 a finished plan waits Stuck as `plan_review`, with `approve`, `retry`, `recipe` and `cancel`. The only way to change the plan is another plan round, which starts over without the engineer.
The maintainer decided on 2026-10-26 that gate 1's corrections happen in an interactive session written in the recipe (#589, #19, #390), and on 2026-10-27 that the plan lenses do not run again after one: the engineer in the session reviews the plan, and the gate needs a new `approve` anyway.
Since ADR 0222 a brewer step can be interactive: `foedrum brew` opens its session in the terminal, `/foedrum:brew` in a new window, and `serve` waits Stuck `waiting_for_session`.
Two things were missing. A recipe step ran only when the batch reached it, so nothing made a step run only when a person chose it. And the Brewmaster, which only reads, leaves its plan in its own attempt's worktree, uncommitted, so a later attempt's worktree does not hold the plan to correct (ADR 0066).

## Decision

### A step a person's choice schedules
- **A brewer step may say `"chosenBy": "lauter"`**: only a person's `lauter` schedules it, and no step continues to it. `mash` gets one, `{ "id": "lauter", "brewer": "brewmaster", "interactive": true, "prompt": "…", "chosenBy": "lauter" }`, after its `plan` step.
- **Only an interactive step is chosen**: the recipe schema refuses `chosenBy` without `"interactive": true` (`Only an interactive step is chosen by a person (ADR 0286)`). A choice asks for a person in the conversation; a headless step a person schedules is a retry or a rewind.
- **One step per option**: the loader refuses a recipe with two steps chosen by the same option, naming both.
- **No step continues to it** (`after`, `src/engine/recipe-files.ts`): the step before it goes past it, so `mash` still ends on `plan` and sticks as `plan_review` as before. After the chosen step the recipe is done, so its plan is the latest and sticks as `plan_review` again, naming its attempt (`continueAfter`, `latestPlan`). When #587's plan lenses stand between `plan` and `lauter`, they are not run again after a session for the same reason: a session's success goes to the recipe's end, not to the steps before it.
- `decoction` takes the same step when #587 builds it.

Rejected: a rewind to a named step (ADR 0066; `plan_review` does not offer it, it needs every repository's commit, and the step after the plan would still be entered); a `when` (it reads only the recipe's settings, which do not change per batch); a recipe of its own for the session (a recipe change starts from the first step, and the plan would be planned again); a bare `"onlyWhenChosen": true` (it would not say which choice schedules the step, and `decoction` will need the same).

### The `lauter` choice
- **`plan_review` offers `lauter` after `approve`**: `approve`, `lauter`, `retry`, `recipe`, `cancel` (`stuckOptions`).
- **`lauter` on a batch Stuck as `plan_review` appends `batch.resumed` with the action `lauter`**, with who and from where, as every command that changes state (ADR 0030), **and schedules a fresh attempt of the recipe's step chosen by `lauter`**: a fresh session, never a retry of the one before (ADR 0222). Each lauter is a new attempt of that step, and a chosen step counts its brewer's `maxAttempts` per choice: only the attempts since the step's latest success count (`sinceSuccess`, `src/engine/recipe-files.ts`, as the openPullRequest action counts a round, ADR 0219), so a session after a successful one still waits for a session again on an invalid plan. Every other step still counts its attempts over the batch's whole life (ADR 0053); the plan step's retries from `plan_review`, which count the same way, are #731.
- **It is refused** in any other lane, naming the lane, and on a batch Stuck for another reason, naming it, with `approve`'s words; and when the batch's recipe has no step chosen by `lauter`: `the recipe <name> of batch <id> has no step a lauter chooses`. Like `approve`, it reads the lane's reason, not the stored options, so a batch recorded Stuck as `plan_review` before this can be lautered, and it replays as it did: the guard before append (`src/engine/admit.ts`) admits its `batch.resumed` by that reason too, as it does `batch.approved` (ADR 0281).
- **A retry of `plan_review` after a lauter plans again** in the step of the batch's latest plan that no choice schedules (`plan` in `mash`), never in another session: a retry is ADR 0275's plan again, and `lauter` is the way to a session.
- An older Foedrum cannot read a `batch.resumed` with `lauter`, or a Stuck event whose options name it.

### `foedrum lauter <batch>` opens the session
- **`foedrum lauter <batch> [--as <name>]`** is a command of the registry and the plugin's `/foedrum:lauter` (ADR 0125). It takes a batch, as `approve`, `retry` and `cancel` do, not the issue (`'#n'`) #589 named: the choice is about one batch's plan, the next step that names it sits beside theirs, and a batch id cannot pick an issue's later batch by mistake. It lauters the batch it names; one that is not Stuck as `plan_review`, such as an earlier batch of an issue ordered again, is refused with its own lane. It finds the issue of the batch, as `foedrum brew` takes it (`<alias>#<n>` for a target repository's), and runs brew's driver on it with the lauter recorded at its start (`runBrew`, `lauter` in `BrewRequest`), so the session opens as every interactive step's does (ADR 0222).
- **It takes the batch over** from a driver that holds it, as `foedrum brew --take` does (ADR 0124): a lauter while `serve` drives the batch moves it to this driver, and `serve` leaves it.
- **On a terminal** the session opens in the foreground, and its out doc settles the attempt; brew then ends Stuck as `plan_review` on the session's plan (exit 3).
- **Without one** (inside Claude Code, or stdin not a terminal) the lauter is still recorded, the driver parks the attempt as `waiting_for_session`, and brew exits 3 with the line that names the brew to run in a terminal. `/foedrum:lauter` then runs `foedrum brew <issue> --new-window`, as `/foedrum:brew` does.

### The plan the session corrects
- **A new input source, `plan`**: the out doc of the batch's latest plan, read from the worktree of the attempt that wrote it (`latestPlan`), as a `step:` input is read (ADR 0059). It is filled only for an attempt of a step a person's choice schedules; on any other step it is left out, as the input of a step the batch skipped is, so the `plan` step and its retries plan from the order as ADR 0275 has them.
- **The Brewmaster has it** (`{ "name": "plan", "from": "plan" }`), and its prompt says that when {plan} is given, it corrects that plan with the person. One brewer file serves both steps, so there is no second prompt to keep in step.

Rejected: `step:plan` (it reads the `plan` step's latest success, so a second lauter would lose the first one's corrections); a second brewer file for the session (two prompts for one schema); seeding the session's out doc with the plan (the runner gives every attempt an empty out doc, and the Brewmaster's prompt asks it to write one).

### What the session ends with
- **The same out doc as the plan step**: the Brewmaster's `plan` schema, its `touches` check (ADR 0233) and its body check (ADR 0275), with no code of its own. An invalid plan fails the attempt retryably, and the batch waits Stuck `waiting_for_session` for a person to reopen it, never in a loop (ADR 0222). A skip from there ends the session's step, and the batch waits for a review of the plan before it again.
- **`approve` after a lauter signs off the session's plan**, by its attempt and its digest (ADR 0281), unchanged: `plan_review` names the session's attempt.
- **The plan comment says so**: under its full plan's link, `Changed in a session by <who> (<via>) at <time>.`, when its plan is an attempt a person's lauter scheduled; `<who>` and `<via>` are the lauter's, and `<time>` is when the session opened (`interactiveSince`, ADR 0222). The fold keeps the lauter's `by` and `via` on the attempt it schedules (`chosen`), and on a retry of that attempt, a session reopened after an invalid plan or a lost one, so the log gains nothing more.
- **The status comment lists the chosen step only once it has an attempt** (`listedSteps`, `src/engine/status-comment.ts`): a step only a person's choice runs is not work the batch has still to do, so a plan approved without a lauter never shows it as pending.
- **The next step names it** (`planNextStep`), for `foedrum stuck`, the status comment and the plan comment: `…; sign it off with foedrum approve <batch>, correct it in a session with foedrum lauter <batch>, plan it again with foedrum retry <batch>, or end it with foedrum cancel <batch>. …`

## Consequences
- A `mash` batch at gate 1 can be corrected with the engineer in the conversation, and still needs an `approve` after it.
- Under `serve`, a lauter from a terminal takes the batch over; from the plugin it costs a new window, as an interactive step's session does.
- A lauter's plan is a new attempt: an approval of the plan before it does not carry over (ADR 0281).
- Every plan comment and status comment of a batch waiting as `plan_review` gets one more revision for its next step's words.
