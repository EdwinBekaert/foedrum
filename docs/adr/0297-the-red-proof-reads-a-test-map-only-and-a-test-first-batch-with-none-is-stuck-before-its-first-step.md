# 0297. The red proof reads a test map only, and a test-first batch with none is Stuck before its first step

Date: 2026-11-02 · Status: Accepted · Amends [0274](0274-the-red-proof-reads-line-coverage-of-the-change-and-a-test-map-not-test-names.md) (the name reading it supersedes is gone, and what a test-first batch with no map does), [0258](0258-a-gauger-its-red-proof-sent-back-may-name-its-tests-without-a-commit.md) (its names-only `done` is withdrawn), [0074](0074-git-commit-grants-fixed-git-rules-and-done-needs-a-commit.md) (its divergence for a `done` without a commit holds for every Gauger again), [0284](0284-a-test-map-new-in-the-batch-never-guards-less-than-no-map.md) (its fallback to ADR 0078's lists ends with them), [0298](0298-the-maltster-s-survey-ends-without-a-session-for-a-fresh-map-and-its-check-sends-a-disagreement-back-once.md) (the Stuck start it kept "until #747") and [0078](0078-the-red-proof-reads-the-test-report-and-testsunchanged-compares-lines.md) (its Stuck start for a repository without `testReport`)

## Context
[ADR 0274](0274-the-red-proof-reads-line-coverage-of-the-change-and-a-test-map-not-test-names.md) decided that the red proof and `testsUnchanged` read a test map and the runner's reports, never test names.
Since #709 and #711 a repository with a map does so, and one without kept the name reading of [ADR 0078](0078-the-red-proof-reads-the-test-report-and-testsunchanged-compares-lines.md), [0176](0176-a-test-s-name-is-declared-only-where-a-declaration-writes-it.md), [0178](0178-a-name-before-a-parenthesis-declares-a-test-only-where-no-call-can-stand.md), [0182](0182-a-call-after-a-less-than-or-a-closing-brace-declares-no-test.md) and [0262](0262-a-string-literal-declares-a-test-only-in-a-file-that-declares-a-test-at-the-step-s-tip.md), with [ADR 0258](0258-a-gauger-its-red-proof-sent-back-may-name-its-tests-without-a-commit.md)'s names-only `done` and [ADR 0284](0284-a-test-map-new-in-the-batch-never-guards-less-than-no-map.md)'s fallback to ADR 0078's lists.
Since #708 ([ADR 0298](0298-the-maltster-s-survey-ends-without-a-session-for-a-fresh-map-and-its-check-sends-a-disagreement-back-once.md)) the Maltster's survey proposes a map before the Gauger in a repository that keeps its map, so "no map" no longer happens there, and #750 moved the demo and the Nip fixture onto a real map.
Two cases still have no map: a Brewery that keeps a repository's map (`"testMap": "brewery"`) and has no `test-maps/<owner>/<name>.jsonc`, which no survey can write ([ADR 0282](0282-a-stale-test-map-sends-back-the-change-that-made-it-and-the-maltster-surveys-a-new-one.md)); and a test-first recipe without a survey step, such as a Brewery's own, in a repository with no `.foedrum/test-map.jsonc`.

## Decision
- **The name reading goes.** In `src/checks/red-proof.ts`, `judgeRed`, `declares` and its forms (ADR 0176, 0178, 0182) and `EXPRESSION_END`; in `src/checks/tests-unchanged.ts`, `DECLARATIONS`, `ASSERTIONS` and `changedTests`; in `src/checks/step-commits.ts`, `readTestFiles` (ADR 0262).
  The red proof judges only by `judgeMapped`; the load-error texts (`LOAD_ERRORS`, [ADR 0269](0269-the-red-proof-refuses-net-s-assembly-and-type-load-failures.md)) stay.
- **`testsUnchanged` keeps only the map's lines.** With no map at the base nor at the proven step's tip, the guard blocks the attempt on its environment: `the guard testsUnchanged finds no test map of <repo> where the batch started or at the tip of step <of> (ADR 0297)`.
  The Stuck start below makes this rare, but a batch still reaches it when its red proof passed before the upgrade, by name, in a repository with no map, or when the Brewery's `test-maps/<owner>/<name>.jsonc` is removed and `foedrum serve` restarted while the batch brews; a guard that guarded nothing there would pass in silence.
  The guard no longer reads the attempt's own diff, which only the lists needed.
  ADR 0284's rule ends with the lists, as it said it would: a map new in the batch guards its test areas, and the test-design lens and the status comment's sensitive path ([ADR 0201](0201-a-repository-names-its-sensitive-paths-and-a-batch-that-touches-one-says-so.md)) name a change to it.
- **A test-first batch with no map is Stuck before its first step**, on its environment, before a brewer spends a token, where `foedrum serve` refused one without `testReport` before (ADR 0078):
  - **Kept by the Brewery, with none**: `recipe <recipe> proves its tests red, which needs a test map of <repo>: the Brewery keeps it and has none, so add test-maps/<owner>/<name>.jsonc to the Brewery (ADR 0297)`, with a survey step or without, since no survey writes the Brewery.
  - **Kept by the repository, in a recipe without a survey step (or one whose `when` skips it), with no map where the batch started**: `recipe <recipe> proves its tests red, which needs a test map of <repo>: commit .foedrum/test-map.jsonc to <repo>, or add a survey step to the recipe (ADR 0297)`. The recipe still loads.
  - A map that cannot be read is not refused there: the red proof's existing Stuck names why.
- **How the second is read.** The step runner's `refuse` may answer with a promise; the driver wiring reads the repository's map with git (`testMaps`) at the commit the batch started at in that repository, the same commit for every attempt, so no attempt's own commits change the answer.
  The attempt waits for the read and starts its runner only after it; a stop during the read cancels the attempt and starts nothing, and a read that throws blocks it on its environment.
  A Brewery order's attempts in its checkouts folder ([#763](https://github.com/EdwinBekaert/foedrum/issues/763)) never get here: its writing steps are refused before.
- **The red proof says the same** where it finds no map at the base nor at its tip, in the words above for where the map is kept.
- **ADR 0258's names-only `done` is withdrawn.** A Gauger a failed red proof of its step sent back that ends `done` without a commit is ADR 0074's divergence again; the red proof reads no names, so naming tests without a commit changes nothing it could read.
  `namesOnly` goes from the attempt's limits, and the attempt plans no longer need the recipes' red proofs.
- **`testReport` stays in `foedrum.jsonc`**: the check runner still reads its path where a run's tests outside the map are found (ADR 0282); it no longer lets a batch with no map brew.
- The Gauger's prompt no longer asks for test names as the runner reports them; it still names its tests and regression tests in its out doc, which the pull request and the test-design lens show.

## Consequences
- The red proof works the same in every language a test runner reports in: no pattern list to keep.
- About 600 lines and their tests leave `src/checks/`.
- A Brewery that keeps a repository's map must write it before its first test-first batch; a Brewery's own test-first recipe without a survey needs the repository to commit one, or a survey step.
- A Gauger whose first commit was right but whose red proof failed has to commit again; `retry` and `skip` work as for any divergence.

## Alternatives considered
- **Keep the name reading for repositories with no map.** Two code paths for one check, the second one the gap ADR 0274 was written to close.
- **Brew a batch with no map with a red proof that reads the report alone** (any failing test). Without a map nothing says which changed files are tests, so a step that only changed code would pass when an older test fails.
- **Read the map at each attempt's own start** instead of the batch's. A later attempt would read the batch's own commits, so the answer could change between attempts of one batch.
