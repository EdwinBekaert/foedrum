# 0369. A recipe's routes count their rounds per run, an open pull request's over the batch's life

Date: 2026-11-10 · Status: Accepted · Amends [0064](0064-test-first-recipes-when-onblocked-and-a-red-proof-required.md) (an `onBlocked` route's rounds count from the batch's latest run, not over its whole life), [0069](0069-check-steps-run-the-repositorys-commands-in-an-attempt-of-their-own.md) (so do an `onFail` route's), [0354](0354-every-finding-of-a-taster-goes-back-along-one-on-findings-route.md) and [0357](0357-after-a-round-back-a-group-runs-again-only-its-every-round-children-and-those-with-findings.md) (a group's two rounds are two in each run, not in all) and [0219](0219-a-failing-check-on-an-open-pull-request-sends-its-batch-back-to-a-fix-step.md) (its consequence that the recipe's own routes count over the batch's life holds across runs only for `onPullRequestFail`)

## Context
[ADR 0064](0064-test-first-recipes-when-onblocked-and-a-red-proof-required.md) counts the rounds a route used as the attempts of its `goto` step it scheduled, over the batch's whole life (`roundsOf`, `src/engine/recipe-files.ts`).
A later run of the recipe, after a person's recipe choice from Stuck (the same recipe again, or a return to it through another) or a rewind, started with the rounds the earlier run used already spent.
#981 found it in the tests of #972: a batch of a recipe whose Taster's `onFindings` has `maxRounds: 1` used its round in run 1; chosen again from Stuck, its Taster's first finding in run 2 made it Stuck at once, with no round back.
The tests used a copy of the recipe with `maxRounds: 2` to get past it.

The fold already keeps where the batch's latest run began: `runFrom`, how many attempts of its path started before its latest recipe choice or rewind ([ADR 0357](0357-after-a-round-back-a-group-runs-again-only-its-every-round-children-and-those-with-findings.md)).
`keptRound`, `keptChildren` and `attemptStart` count from it.

One function counts the rounds of all three kinds of route: `failed` (`onFail`), `findings` (`onBlocked`, `onFindings`) and `pull_request` (`onPullRequestFail`).
A batch has one pull request, which stays open across its runs: a later run pushes to the same one, and a `pull_request_failed` Stuck offers `rewind` and `recipe` ([ADR 0219](0219-a-failing-check-on-an-open-pull-request-sends-its-batch-back-to-a-fix-step.md)).

## Decision
Decided by the consultant session on #981 (2026-11-10), from three options.

- **`onFindings`, `onBlocked` and `onFail` count per run.** Their rounds are the attempts of the route's `goto` step that the route scheduled since the batch's latest recipe choice or rewind, at `runFrom`, so each run of the recipe gets its own `maxRounds`. Rounds used in the current run still count: a round back along a route does not move `runFrom`.
- **A run is told by attempt numbers, not by the path.** At each recipe choice and rewind, beside `runFrom`, the fold keeps the first attempt number every step that had attempts gets in the new run, one above its highest then (`runStarts`). A route counts the attempts of its `goto` step numbered from there. The path cannot place an attempt that was abandoned before it started, since such an attempt never starts: a route's attempt that a person's stop or a passed deadline abandoned in run 1 would otherwise count in run 2. A scheduled attempt of the current run, not yet on the path, counts in it.
- **No event or field on disk changes.** `runStarts` is folded from the events already recorded, so an older log folds the same, and drivers of different versions need no joint update.
- **`onPullRequestFail` counts over the batch's life, as before.** Its rounds are the one pull request's, which outlives the batch's runs; a person's `retry` gives it one more round, as ADR 0219 says. A rewind from `pull_request_failed` whose pull request fails again is Stuck at once.

## Consequences
- A batch Stuck today because its later run had no round left gets one once this ships: a person can `retry` it, or choose its recipe again.
- A batch with no recipe choice or rewind has no `runStarts`, so every round counts, as before; one from before the path was kept gets them from its events like any other.
- The Stuck reason's `roundsOut.rounds` counts the current run's rounds only.
- **Migration: none in a Brewery's files.** A Brewery's recipes keep their `maxRounds`; only what counts against them changes.

## Alternatives considered
- **Every route per run, `onPullRequestFail` too:** one rule with no branch, but a rewind or a recipe choice would give the same open pull request a fresh set of automatic fix rounds, each a push to it; rejected.
- **`onFindings` alone per run:** the bug #981 names, but a rewind after a check's `onFail` round was used would leave that route none, the same bug for checks; rejected.
- **Mark the run on each scheduled attempt:** a field on `step.scheduled` that an older log lacks, where the fold can tell the run from the attempt numbers.
- **The attempt's place on the path against `runFrom`, as `keptRound` reads it:** the first version of this change; the correctness review found that it counts in the later run an attempt abandoned before it started, which is on no path.
- **Leave abandoned attempts out of the count:** a person's `retry` from Stuck schedules with no route, so after a stop and a retry in one run the abandoned attempt is that round's only record.
