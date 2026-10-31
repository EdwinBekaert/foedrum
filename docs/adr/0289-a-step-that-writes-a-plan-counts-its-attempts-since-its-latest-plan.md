# 0289. A step that writes a plan counts its attempts since its latest plan

Date: 2026-10-31 · Status: Accepted · Amends [0053](0053-recipe-files-reach-the-engine-brewer-steps-in-a-line-first.md) (not every brewer step counts its attempts over the batch's whole life) and [0286](0286-foedrum-lauter-corrects-a-plan-at-gate-1-in-an-interactive-session.md) (the plan step's retries from `plan_review` count per round too)

## Context
Since ADR 0053 a brewer step gets another attempt while it has had fewer than its brewer's `maxAttempts`, counted over the batch's whole life, successes included (`mayRetry`, `src/engine/recipe-files.ts`).
Since ADR 0275 a finished plan waits Stuck as `plan_review`, and `foedrum retry` plans again in a fresh attempt of the plan step.
So in `mash`, whose Brewmaster has two attempts, a plan succeeds, a retry's plan succeeds, and the next retry's first failure sticks the batch `attempts_exhausted`, although only one attempt failed (#731).
ADR 0286 counted a step a person's choice schedules per round, the attempts since its latest success (`sinceSuccess`, as the openPullRequest action counts a round, ADR 0219), and left the plan step to this record.

## Decision
- **A brewer step whose brewer writes a plan counts the attempts since its latest success** toward `maxAttempts`, as a step a person's choice schedules does: a brewer whose `output.schema` is `plan` (ADR 0233). Every other brewer step still counts over the batch's whole life (ADR 0053).
- **The recipe decides it, not the lane**: only a step that writes a plan can end as `plan_review` and be planned again from it, so the brewer's out doc schema names the step, with no new recipe field.
- A plan step that fails `maxAttempts` times from its first attempt, or after a plan, still sticks the batch `attempts_exhausted`.
- A lauter's step, which writes a plan and is chosen, counts as before.

Rejected: a recipe field such as `"retryCounts": "perRound"` (a schema change for the set of steps the brewer's schema already names); reading the lane, counting only the attempts after the latest `retry` from `plan_review` (the count would depend on events the recipe does not see, and a plan step has no other way to run again after a success today).

## Consequences
- A plan can be planned again from its review as often as a person asks; each round has the brewer's `maxAttempts`.
- When #587's plan lenses send a plan back to its plan step with `onBlocked` findings, each round there also has the brewer's `maxAttempts`; the route's `maxRounds` bounds the rounds.
