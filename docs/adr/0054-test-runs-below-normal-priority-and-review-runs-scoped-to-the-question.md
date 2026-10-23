# 0054. Test runs below normal priority, and review runs scoped to their question

Date: 2026-10-16 · Status: Accepted · Amends [0034](0034-brett-mutants-as-structured-line-edits.md), [0036](0036-test-budget-in-cpu-time.md) and [0040](0040-brett-covers-scripts-and-kills-need-a-failing-test.md) · Amended by [0089](0089-a-file-over-the-test-budget-is-measured-again-alone.md), [0134](0134-the-red-proof-runs-once-the-review-drops-its-coverage-delta-and-property-and-chaos-run-on-one-leg-per-pull-request.md) and [0150](0150-mutant-tests-drops-its-coverage-option.md)

## Context
On 2026-10-16 four parallel issue sessions each spent 52–65 of 90 minutes waiting on test runs, against 17–25 minutes of model time (#140). The machine was not the limit (18 % CPU on average), the scope of the runs was:

- Stage 4 of /brew-review ran the whole `test/{unit,property,chaos}` suite once for the baseline and once per mutant, although a mutant can only fail a test that reaches its file.
- Stage 5 ran the whole suite, integration tests included, at the base and then at the head, with coverage over every file in `src/` and `scripts/`, although the table reports only the changed files.
- Sessions ran `npm run check` and `npm run test:integration` after each red/green pair and each review fix.

The same evening a mutation run froze the desktop: `node --test` starts one process per test file, up to the number of cores minus one, at normal priority, and about ten CPU-bound processes took all twelve cores, so the terminal and the other sessions could not take input.

## Decision
- **Test runs on a developer's machine run below normal priority.** When `CI` is not set (or empty), npm test's preload (`scripts/test-cpu-time.ts`) lowers the runner and every test process to `PRIORITY_BELOW_NORMAL`, `npm run check` lowers itself before it starts its steps, and `npm run test:integration` and the coverage runs of /brew-review load `scripts/lower-priority.ts`, which only does that (npm test's preload refuses process starts, which integration tests need). Child processes inherit the priority on Windows, macOS and Linux. A process already at that priority or lower keeps it, and a refusal leaves it as it was. CI keeps normal priority. The logic is `scripts/below-normal-priority.ts`. It stays in `scripts/` rather than the platform module: it is development tooling that only test runs and the check load, and no part of Foedrum changes a process's priority, so `src/platform/` would carry it without a caller.
- **The mutation check runs the tests a mutant can fail.** `scripts/mutant-tests.ts` lists the test files in `test/unit/`, `test/property/` and `test/chaos/` that import a mutated file directly or through one module in between; the baseline and every mutant run use that one list for all of the review's mutants, with `--test-concurrency` at half the cores, one run after the other. With no such file, the runs use the three layers as before. ADR 0040's verdict is unchanged: since the baseline ran the same files, a test missing from a mutant's run is missing because its file failed. A mutant must edit a file the change touches (`scripts/mutants.ts --touched` with the review's `files.txt`): Brett was asked for mutants of the changed code, and now one elsewhere is invalid, not a run.
- **The coverage delta measures only the changed files.** Stage 5 names each changed file under `src/` and `scripts/` with `--test-coverage-include`, runs only the test files that can run one of them (`scripts/mutant-tests.ts --coverage`: every layer, integration included, that imports one at any depth or names it in a string, as a test that starts it as a process does), and runs the base and the head at the same time, each in a scratch tree of its own. Run counts stay npm test's: `FOEDRUM_RUNS=20`, which #140 proposed, would raise the chaos cases from 5 seeds to 20 and the invariants from 15 to 20, and cut only the fold properties (200).
- **Each step runs what it changed.** A red or green step runs its changed test files; `npm run check` runs once before the push (the gate runs it anyway); `npm run test:integration` runs once per review round, after the round's fixes, when the diff touches a module an integration test covers, and never for documentation alone.

## Consequences
- The desktop stays responsive during a test run, and a run on an idle machine takes as long as before: priority only decides who waits when cores are busy.
- The per-file CPU time budget (ADR 0036) measures the same work. For `test/property/scenarios.test.ts`, 15 interleaved pairs gave a median of 0.73 s of CPU time at normal priority and 0.70 s below normal: the difference is noise.
- Under load from other normal-priority work, a below-normal test run takes longer in wall time. That is the trade: the interactive work goes first.
- On Linux, `setpriority` changes the calling thread, so threads node started before the preload ran keep their priority; the test code runs on the main thread, and processes started from it inherit the new priority.
- A mutant that only a test two or more modules away can fail now survives, where it was killed before. Survivors are advisory (ADR 0017), and the summary shows each with its patch. On the planted-defect sample every verdict is unchanged (see Verification).
- Stage 5 for #136 (568 changed lines) takes 8 s instead of 277 s on the same machine, with the same coverage table (see Verification).

## Alternatives considered
- **Start test runs through `nice` or `start /belownormal`:** a wrapper per shell and platform in the skill and in package.json, and a test run started any other way still runs at normal priority.
- **Lower `--test-concurrency` in npm test:** a slower `npm run check` on every push, and other sessions still wait for the cores it does use.
- **Select a mutant's tests from a coverage map:** exact, but it needs a coverage run first, which is the cost this removes.
- **Compare only the tests of files a mutant's run reported, with one baseline over the union:** the same savings, but a change to the verdict of ADR 0040; one shared list keeps the verdict as it is.

## Verification
Measured on 2026-10-17 on the twelve-core Windows machine of #140, with other sessions running.

- **Stage 5 on #136** (`src/brewers/claude-runner.ts` and `claude-stream.ts`): the old way, the whole suite with coverage over every file, took 127 s at the base and 150 s at the head, one after the other (277 s). The new way runs 3 test files per tree, both trees at once: 8.4 s. Both report the same line, branch and function percentages and the same uncovered lines for both files.
- **Stage 4 on the planted-defect sample**, with this branch's skill: Brett proposed 4 mutants; `mutants.ts --touched` found 3 valid and one that changes nothing (with `brewery-name.ts` left out of `files.txt`, it also marks that file's mutant as not touched). `mutant-tests.ts` chose 3 test files. Baseline and mutants took 5 s in all, against 96 s with the whole suite, with the same verdicts and the same killing tests: the backoff and wait-for-merge mutants killed, and the dropped end anchor in `isBreweryName` survived, which is the planted gap of rejection-only tests.
- **Stage 5 on the planted-defect sample**: 4 test files, 1 s; the four new files are at 100 %.
- **The three real-git integration suites**, run on their own, old and new fixture interleaved, median of 3: state-branch 39.4 s → 32.9 s, attempt-worktrees 34.3 s → 22.1 s, worktrees-clean 27.8 s → 27.3 s. Making the seed repository once per file saves 4 to 6 git processes per test; most of each test's time is the git work it tests.
