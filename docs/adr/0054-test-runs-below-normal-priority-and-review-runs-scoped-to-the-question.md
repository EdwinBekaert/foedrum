# 0054. Test runs below normal priority, and review runs scoped to their question

Date: 2026-10-16 · Status: Accepted · Amends [0036](0036-test-budget-in-cpu-time.md) and [0040](0040-brett-covers-scripts-and-kills-need-a-failing-test.md)

## Context
On 2026-10-16 four parallel issue sessions each spent 52–65 of 90 minutes waiting on test runs, against 17–25 minutes of model time (#140). The machine was not the limit (18 % CPU on average), the scope of the runs was:

- Stage 4 of /brew-review ran the whole `test/{unit,property,chaos}` suite once for the baseline and once per mutant, although a mutant can only fail a test that reaches its file.
- Stage 5 ran the whole suite, integration tests included, at the base and then at the head, with coverage over every file in `src/` and `scripts/`, although the table reports only the changed files.
- Sessions ran `npm run check` and `npm run test:integration` after each red/green pair and each review fix.

The same evening a mutation run froze the desktop: `node --test` starts one process per test file, up to the number of cores minus one, at normal priority, and about ten CPU-bound processes took all twelve cores, so the terminal and the other sessions could not take input.

## Decision
- **Test runs on a developer's machine run below normal priority.** When `CI` is not set (or empty), npm test's preload (`scripts/test-cpu-time.ts`) lowers the runner and every test process to `PRIORITY_BELOW_NORMAL`, `npm run check` lowers itself before it starts its steps, and `npm run test:integration` and the coverage runs of /brew-review load `scripts/lower-priority.ts`, which only does that (npm test's preload refuses process starts, which integration tests need). Child processes inherit the priority on Windows, macOS and Linux. A process already at that priority or lower keeps it, and a refusal leaves it as it was. CI keeps normal priority. The logic is `scripts/below-normal-priority.ts`.
- **The mutation check runs the tests a mutant can fail.** `scripts/mutant-tests.ts` lists the test files in `test/unit/`, `test/property/` and `test/chaos/` that import a mutated file directly or through one module in between; the baseline and every mutant run use that one list for all of the review's mutants, with `--test-concurrency` at half the cores, one run after the other. With no such file, the runs use the three layers as before. ADR 0040's verdict is unchanged: since the baseline ran the same files, a test missing from a mutant's run is missing because its file failed.
- **The coverage delta measures only the changed files.** Stage 5 names each changed file under `src/` and `scripts/` with `--test-coverage-include` and runs the base and the head at the same time, each in a scratch tree of its own. Run counts stay npm test's: `FOEDRUM_RUNS=20`, which #140 proposed, would raise the chaos cases from 5 seeds to 20 and the invariants from 15 to 20, and cut only the fold properties (200).
- **Each step runs what it changed.** A red or green step runs its changed test files; `npm run check` runs once before the push (the gate runs it anyway); `npm run test:integration` runs once per review round, after the round's fixes, when the diff touches a module an integration test covers, and never for documentation alone.

## Consequences
- The desktop stays responsive during a test run, and a run on an idle machine takes as long as before: priority only decides who waits when cores are busy.
- The per-file CPU time budget (ADR 0036) measures the same work. Measured as in #41 (median of 30 runs, interleaved), RESULT.
- Under load from other normal-priority work, a below-normal test run takes longer in wall time. That is the trade: the interactive work goes first.
- On Linux, `setpriority` changes the calling thread, so threads node started before the preload ran keep their priority; the test code runs on the main thread, and processes started from it inherit the new priority.
- A mutant that only a test two or more modules away can fail now survives, where it was killed before. Survivors are advisory (ADR 0017), and the summary shows each with its patch. On the planted-defect sample and on #136, every verdict is unchanged (see Verification).
- One review round of #136 (568 changed lines) spent RESULT on tests instead of 1,224 s.

## Alternatives considered
- **Start test runs through `nice` or `start /belownormal`:** a wrapper per shell and platform in the skill and in package.json, and a test run started any other way still runs at normal priority.
- **Lower `--test-concurrency` in npm test:** a slower `npm run check` on every push, and other sessions still wait for the cores it does use.
- **Select a mutant's tests from a coverage map:** exact, but it needs a coverage run first, which is the cost this removes.
- **Compare only the tests of files a mutant's run reported, with one baseline over the union:** the same savings, but a change to the verdict of ADR 0040; one shared list keeps the verdict as it is.

## Verification
RESULTS
