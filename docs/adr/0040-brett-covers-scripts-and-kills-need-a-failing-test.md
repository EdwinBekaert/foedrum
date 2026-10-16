# 0040. Brett covers scripts/, and only a test the mutant makes fail kills it

Date: 2026-10-16 · Status: Accepted · Amends [0017](0017-test-first-recipes-and-tasting-lenses.md) and [0034](0034-brett-mutants-as-structured-line-edits.md)

## Context
Two gaps in the mutation check of Foedrum's own review skill (issue #43, raised in the review of #104):

- **Brett only mutated `src/`.** ADR 0034 makes a mutant valid only for a file under `src/`. In this repository, `scripts/` holds the local gate, `npm run check`, the dependency guard, the worktree cleanup (which deletes things) and the review tooling itself. That code got red proofs and lens reviews but never a mutation check, although it is exactly the code these reviews depend on.
- **A failing `npm test` counted as a kill.** `npm test` fails for reasons that have nothing to do with the mutant: a test file over the per-file CPU time budget (ADR 0036; a mutant can make code slower, and under load the #104 session had to read such runs as survivors by hand), a coverage threshold, or a test that already fails without the mutant. On the planted-defect sample, the ADR 0038 preload refuses the planted unit test that runs `git init`, so `npm test` fails at HEAD without any mutant. Every mutant counted as killed, and the planted "weak tests" defect (two real survivors) went unseen: in the run before this change, mutants 4 and 5 failed only on that refused test.

ADR 0017 already says a mutant is a confirmed survivor "only when the tests still pass"; it does not say what counts as the tests failing.

## Decision
- **Mutants may edit files under `src/` and `scripts/`**, with the same rules ADR 0034 gives for `src/`: a plain relative path, an existing regular file, a folder that is not itself a link, and no link out of it. Tests, `package.json`, `.npmrc` and configuration stay out of reach.
- **Only a test that fails because of the mutant kills it.** The check runs the tests once without the mutant (the baseline) and once per mutant, and compares the outcome of each test, identified by its file, suites and name:
  - a test that passed in the baseline and fails, or no longer reports (its file failed to load), kills the mutant;
  - so does a failure the baseline did not have (for example a process start the preload refused);
  - a test that fails in both runs does not; neither does the time budget nor a coverage threshold, which are not tests.
  - a run that hits its deadline counts as killed (timed out), as before;
  - with no passing test in the baseline, nothing can be judged, and the check says so instead of counting kills.
- In the review skill, the test runs use node's runner directly, with the preload `npm test` uses (so process starts are still refused, ADR 0038) and a reporter that writes each test's outcome as a JSON line (`scripts/test-outcomes-reporter.ts`); `scripts/mutant-verdict.ts` makes the comparison. Both, and the preload, come from the review criteria, so neither the mutant nor the pull request changes how the tests are run and read. When the engine's Brett is built, its gravity reading for a mutant is compared the same way with the reading of the unmutated `scratch` tree.

## Consequences
- The gate, the check and the review tooling get mutation checks. A mutant of the tooling that the mutation run itself uses (the preload or the reporter) cannot change the verdict, because the run takes them from the criteria; it is judged by its own unit tests like any other code.
- Load no longer turns a survivor into a kill, and a pull request whose tests already fail still gets a mutation check.
- Each review runs the tests once more (the baseline). That is one run against three to five mutant runs.
- A verdict names the tests that killed the mutant, so the summary can show what caught it.
- A flaky test can still kill a mutant at random. That was already true, and the baseline makes it rarer, since a test that fails in both runs no longer counts.

## Alternatives considered
- **Run `npm test` with the budget turned off by an environment variable.** Simple, but the coverage thresholds and the tests that fail without the mutant would still count as kills, and the exit code still says nothing about which test failed.
- **Count a mutant as killed when the exit code is not 0 and the budget reporter printed nothing.** That depends on reading free-form output, and still counts a test that fails anyway.
- **Mutate `scripts/` only for files outside the test harness.** The harness files the run uses come from the criteria, so a mutant of them changes only the scratch tree's copy, and their own unit tests judge it; a list of excluded files would only drift.
