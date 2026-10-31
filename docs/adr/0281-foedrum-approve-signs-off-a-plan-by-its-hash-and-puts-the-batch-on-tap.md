# 0281. `foedrum approve` signs off a plan by its hash and puts the batch on tap

Date: 2026-10-31 · Status: Accepted · Amends [0275](0275-a-finished-plan-waits-stuck-for-its-review-and-every-comment-links-the-doc-it-sums-up.md) (`plan_review` offers `approve`, the next step names it, and the plan comment's Gate section shows the gate)

## Context
Since ADR 0275 a recipe that ends on a plan sticks its batch as `plan_review`, with `retry`, `recipe` and `cancel`. Nothing signs a plan off: the next step tells the engineer to cancel the batch and order its sub-orders by hand, and the plan comment's **Gate** section says "None yet." #588 is gate 1: a person signs off the plan they read, and a plan that changed after it needs a new sign-off. #590 later turns a signed-off plan into sub-issues; #589 adds corrections before the sign-off.

## Decision
- **`approve` joins `plan_review`'s options**, first: `approve`, `retry`, `recipe`, `cancel` (`stuckOptions`, `src/engine/decide.ts`). No gate step in the recipe and no new Stuck reason: the wait ADR 0275 built is the gate's.
- **`foedrum approve <batch>` approves the plan of the attempt `plan_review` names**, recorded with who and from where, as every command that changes state (ADR 0030); only allow-listed users count, as for every command, with no second rule. It is a command of the registry and the plugin's `/foedrum:approve` (ADR 0125), which shows the plan's line from `foedrum stuck` and asks the engineer before it runs.
- **It appends `batch.approved`, then `batch.on_tap` with no pull request.** `batch.approved` carries `by`, `via`, `at`, the plan's `stepId` and `attempt`, and `plan`, the digest of that attempt's recorded out doc frontmatter (`digestOf` of its JSON, as the comments' digests are made). The fold takes it only from Stuck `plan_review` naming that step and attempt, and only when `plan` is that attempt's digest, so an approval of another plan is refused; it moves the batch to Brewing and keeps the approval on the batch. On tap is then ADR 0059's lane, with everything that follows from it (the worktree cleanup, the open-order place of ADR 0217 freed), and the status comment says `🍻 **On tap**: plan approved by <who> (<via>)`.
- **The two events are one decision, appended together**: no reader sees the batch Brewing between them, and a crash leaves either both or neither.
- **The hash covers the frontmatter, which is on the event**: the fold computes it from events alone. The out doc's body is on the state branch, and needs no hash of its own: ADR 0275's body check holds the body's summary and assumptions to the frontmatter's, and only Foedrum writes the state branch (ADR 0263), so an out doc is not edited after its attempt. A new plan is a new attempt.
- **A changed plan needs a new approve.** A retry plans again in a new attempt, which sticks as `plan_review` again, naming its own attempt; an approval of the attempt before it does not carry over.
- **`approve` on a batch in any other lane is refused, naming the lane**, and, for a Stuck batch, its reason. `approve` reads the lane's reason, not the stored options: a batch recorded Stuck as `plan_review` before this, whose options lack `approve`, can still be approved, and it replays as it did.
- **The next step names it** (`planNextStep`, `src/engine/status-comment.ts`), for `foedrum stuck`, the status comment and the plan comment: `read the plan and its assumptions; sign it off with foedrum approve <batch>, plan it again with foedrum retry <batch>, or end it with foedrum cancel <batch>. Its sub-orders become issues once #590 is built.`
- **The plan comment's Gate section shows the gate**: `Waiting for foedrum approve <batch>.` while the batch waits as `plan_review`, `Approved by <who> (<via>) at <time>.` after, `None yet.` otherwise; `Next:` goes when the batch moves on, as before.

Rejected: staying Stuck after the approval until #590 (Stuck asks a person for something, and an approved plan asks nothing more until #590 builds its sub-issues); `approve <batch> <hash>` (the engineer approves the plan the comment shows, and the attempt already names it); hashing the out doc's body (not on the event, so the fold could not check it).

## Consequences
- An older Foedrum cannot read a `batch.approved` event.
- An approved `mash` batch is on tap and no longer holds an open-order place; its sub-orders are still ordered by hand until #590.
- Every plan comment of a batch waiting as `plan_review` gets one more revision for its Gate line.
