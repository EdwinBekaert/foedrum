# 0324. A diff lens step counts its attempts since its latest review

Date: 2026-11-05 · Status: Accepted · Amends [0053](0053-recipe-files-reach-the-engine-brewer-steps-in-a-line-first.md) (a lens step does not count its attempts over the batch's whole life) and [0321](0321-mash-and-decoction-review-a-plan-through-the-plan-lenses-apart.md) (a step that reviews a diff no longer keeps the whole-life count)

## Context
A Taster has `maxAttempts` 2, and until now a step that reviews a diff counted its attempts over the batch's whole life, reviews included (`mayRetry`, `src/engine/recipe-files.ts`; ADR 0053).
Nip's taste group runs again each time correctness sends the batch back (ADR 0264).
So when correctness #1 asked for changes and acceptance #1 approved, the first failure of acceptance #2, a passing error or a missing out doc, made the batch Stuck as `attempts_exhausted`, abandoning its siblings, though only one attempt had failed (#833).
ADR 0321 fixed this for a step that reviews a plan and left the diff lens step to an issue.

## Decision
- **Every lens step counts the attempts since its latest review**, a verdict or blocked by findings (`sinceReview`), toward its brewer's `maxAttempts`, whether it reviews a diff or a plan. A step's lens or lenses say so, with no test of the folder, since a lens is under `diff/` or `plan/` (ADR 0143).
- **A failure never resets the count**: a Taster that fails its two attempts in one round, the first or a later one, still leaves the batch Stuck as `attempts_exhausted`, and a person's `retry` still gives it one more (ADR 0053).
- **Routes bound the rounds, as they did.** `mayRetry` limits retries, never rounds. A lens step that nothing routes back to, such as Nip's acceptance, runs again only when an earlier step sends the batch back, and each such route has its `maxRounds` over the batch's whole life (ADR 0064).

Rejected: counting since the latest success, as a plan step does (ADR 0289). A blocking lens's findings end its attempt as failed, not succeeded, so that count would leave its next round one attempt short.

## Consequences
- A passing failure of a Taster in a later round costs one more attempt instead of a person's `retry`: at most one more Taster attempt per lens step per round.
- **What stays whole-life after this record:** every other brewer step, unless a person's choice schedules it or its brewer writes a plan (Cellarman, the Finer, the Gauger, the Maltster, Brett), counts `attempts.length`; a check step counts its attempts that read nothing over the batch's life (ADR 0069); a route's rounds count over the batch's life (ADR 0064). A scratch run showed Cellarman, the Finer, the Gauger and a blocking Brett Stuck on one failure after a route back; that defect is #849's, unchanged here.
- **A direction, not built here:** one rule could replace the three counts in `mayRetry`, the attempts since the latest that delivered what the step is for: a success or blocked by findings for a brewer step, a reading for a check. For a real Taster that is `reviewed`, since a done Taster's out doc must have a verdict. #849 decides it.
