# 0325. A step counts its attempts per round

Date: 2026-11-05 · Status: Accepted · Amends [0053](0053-recipe-files-reach-the-engine-brewer-steps-in-a-line-first.md) (no brewer step counts its attempts over the batch's whole life), [0069](0069-check-steps-run-the-repositorys-commands-in-an-attempt-of-their-own.md) (a check counts its empty reads since its latest reading), [0128](0128-an-attempt-a-route-schedules-gets-what-sent-it-back.md) (a fresh retry or answer of a routed attempt gets the route input), [0219](0219-a-failing-check-on-an-open-pull-request-sends-its-batch-back-to-a-fix-step.md) (the action's count is the shared rule, unchanged in effect), [0286](0286-foedrum-lauter-corrects-a-plan-at-gate-1-in-an-interactive-session.md) and [0289](0289-a-step-that-writes-a-plan-counts-its-attempts-since-its-latest-plan.md) (no step keeps the whole-life count, and being blocked by findings closes a round too), [0321](0321-mash-and-decoction-review-a-plan-through-the-plan-lenses-apart.md) and [0324](0324-a-diff-lens-step-counts-its-attempts-since-its-latest-review.md) (the lens step's count is the shared rule)

## Context
`mayRetry` had three counts for a brewer step: since the latest review for a lens step (ADR 0321, ADR 0324), since the latest success for a chosen step or a planner (ADR 0286, ADR 0289), and `attempts.length`, whole-life, for every other (ADR 0053).
Every default brewer has `maxAttempts` 2.
So after one success and one route back, the first failure of Cellarman, the Finer, the Gauger, the Maltster or a blocking Brett made the batch Stuck as `attempts_exhausted`, though only one attempt had failed (#849).
A check step counted its empty reads over the batch's life, so `green`'s third, in any round, spent a round of its route.
And `retryOrStick` reported the attempts of the batch, so a line could read "`acceptance` used its 3 attempts" for a brewer with `maxAttempts` 2.

## Decision
- **One count for every brewer step, and for the openPullRequest action: the attempts since the latest that delivered what the step is for**, a success or blocked by findings (`delivered`, `deliveryRound`, `src/engine/recipe-files.ts`). The action never blocks by findings, so its count reads as it did, with its own limit (ADR 0219).
- **A check step counts its empty reads since its latest reading** (`readingRound`), still at most 3, and a third in one round still takes its `onFail` route.
- **A failure closes no round**, so a step that fails every time is Stuck within its round: `maxAttempts` failures for a brewer step, and a step with no route back that never delivered counts as it always did.
- **A person's `retry` gives one more** (ADR 0053), since it closes no round either: [failed, failed, retry failed] counts 3 and is Stuck again.
- **Routes bound the rounds, as they did.** `mayRetry` limits retries, never rounds, and each route's `maxRounds` counts over the batch's life (ADR 0064). Rounds × retries stay finite.
- **`attempts_exhausted.attempts` records the attempts of the round the step ended in** (`Recipe.roundAttempts`), the failed reading of a check among them, so a check that runs out of its route's rounds records 1. A record already written keeps its number, and only `foedrum status` and the status comment read it; nothing computes a retry from it.
- **The status comment says "1 attempt" in the singular.**
- **A fresh retry or answer of a routed attempt gets what sent the round back**, through `roundRouteOf`, in `routeOf` and in the plan input a findings route adds (ADR 0318). A retry that resumes its session gets only the failure's reason, as before, since its session holds the route input (ADR 0117, ADR 0248). ADR 0128 left this for a later decision; this record makes the case common, as a lost attempt after a route now retries by itself.

Rejected: leaving the check's count (the change is small, and that count let three lost attempts across a batch's rounds spend a round of a route); a recipe field for the count (ADR 0289 rejected it for the same reason: no recipe needs a choice).

## Consequences
- One failure after a route back costs one more attempt instead of a person's `retry`: at most `maxAttempts - 1` more attempts of a step per round, and the rounds are bounded by the routes.
- **After a person's `retry` the number passes the limit**: "`implement` used its 3 attempts" for a brewer with `maxAttempts` 2. It is true, and it says a person gave one more.
- **Two small changes of behaviour beside the fix.** A planner or chosen step blocked by findings and then retried by a person counts from that block, where `sinceSuccess` counted the block, as a lens step did. A Taster's success with no verdict closes a round, where `sinceReview` did not, and a real Taster's out doc must have a verdict (ADR 0324).
- A batch in flight at the upgrade reads the new count at its next failure. A batch already Stuck stays Stuck until a person acts.
- `reviewed` stays as the reading of a lens step's rounds (ADR 0191, ADR 0196), which is about findings, not about attempts.
