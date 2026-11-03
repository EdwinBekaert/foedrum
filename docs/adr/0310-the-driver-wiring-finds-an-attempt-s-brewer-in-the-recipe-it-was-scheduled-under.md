# 0310. The driver wiring finds an attempt's brewer in the recipe it was scheduled under

Date: 2026-11-03 · Status: Accepted · Amends [0309](0309-the-attempt-plans-find-every-brewer-in-the-recipe-its-attempt-was-scheduled-under.md) (the driver wiring's `family` and `resumes` still find an attempt's brewer in the batch's recipe), [0118](0118-retrymode-resume-loads-and-an-answer-resumes-the-session-that-asked.md) (`resumes` asks the brewer of the attempt's step in its batch's recipe)

## Context
Since [ADR 0309](0309-the-attempt-plans-find-every-brewer-in-the-recipe-its-attempt-was-scheduled-under.md), an attempt's plan and limits come from the brewer of its step in the recipe the attempt was scheduled under, through `attemptRecipeOf`.
ADR 0309 left the driver wiring (`wireDriver`, `src/cli/driver-wiring.ts`) as it was, and two of its answers about an attempt still found the attempt's brewer in the batch's current recipe:
- `family`, the model family that says which closed usage window holds the attempt ([ADR 0215](0215-an-opus-or-sonnet-limit-holds-only-the-brewers-of-its-family.md));
- `resumes`, whether a retry or an answer continues the session, from the brewer's `retryMode` ([ADR 0117](0117-a-retry-resumes-the-session-of-the-attempt-before-it-in-that-attempt-s-worktree.md), [ADR 0118](0118-retrymode-resume-loads-and-an-answer-resumes-the-session-that-asked.md)).
After a person chooses another recipe ([ADR 0240](0240-order-and-recipe-work-by-the-brewery-issue-on-both-surfaces.md)) between an attempt's scheduling and its start, the plan runs one brewer and these two ask about another: the usage window of the wrong family holds the attempt, or none does, and the retry follows the other brewer's `retryMode` (#796).
The survey's `surveys` and `mapOnly` ([ADR 0298](0298-the-maltster-s-survey-ends-without-a-session-for-a-fresh-map-and-its-check-sends-a-disagreement-back-once.md)) and the `testsUnchanged` guard's `protects` ([ADR 0274](0274-the-red-proof-reads-line-coverage-of-the-change-and-a-test-map-not-test-names.md)) asked the same of a started attempt's brewer, in the batch's recipe too.
`reads` ([ADR 0301](0301-a-brewery-order-s-read-only-attempt-reads-every-repository-in-a-checkout-of-each.md)) already used the attempt's recipe, written out by hand.

## Decision
- **Every answer the wiring gives about an attempt's brewer finds it in the recipe the attempt was scheduled under**, and in the batch's recipe for an attempt that recorded none: `reads`, `family`, `resumes`, `surveys`, `mapOnly`, and whether the attempt's brewer has the `testsUnchanged` guard, all through one lookup over `attemptRecipeOf` (`attemptBrewers`, `src/cli/attempt-brewers.ts`).
- **An interactive step still never resumes** ([ADR 0222](0222-a-recipe-s-brewer-step-may-be-interactive.md)), in the recipe the attempt was scheduled under.
- **What the batch's recipe schedules next stays on the batch's recipe**, as ADR 0309 keeps it: whether a step is a check (`isCheck`, and so `brews`), the refusal of a batch with no test map ([ADR 0297](0297-the-red-proof-reads-a-test-map-only-and-a-test-first-batch-with-none-is-stuck-before-its-first-step.md)), and the step whose tests `protects` keeps, the `of` of the batch's red proof.
  `protects` is therefore made of two halves on purpose: the guard is the attempt's brewer's, and the tests it keeps are those the red proof that will judge the batch proves red.

## Consequences
- A batch moved to another recipe before its next attempt starts is held by the usage window of the model that attempt actually runs on, and resumes only when its own brewer resumes.
- A survey or a `testMapOnly` attempt scheduled before a recipe change is treated as the survey its plan runs.
- A batch that never changed recipes runs as before.
