# 0303. Brett's mutants run only the test files that cover their line

Date: 2026-11-02 · Status: Accepted · Amends [0054](0054-test-runs-below-normal-priority-and-review-runs-scoped-to-the-question.md) (a mutant's tests come from a coverage map after all), [0171](0171-brett-s-mutants-run-against-their-file-s-direct-tests-first.md) (the two rounds become the fallback of one covered round) and [0040](0040-brett-covers-scripts-and-kills-need-a-failing-test.md) (a verdict reads the baseline's outcomes of the files the mutant ran)

## Context
Stage 4 of /brew-review runs each of Brett's mutants against the test files that import its file directly, and a survivor again against those that import it through one module ([ADR 0171](0171-brett-s-mutants-run-against-their-file-s-direct-tests-first.md)).
For a file much of the code imports, the direct list alone is most of the suite: on #593's review (#547), whose five mutants were in `src/engine/pull-request-fix.ts`, `src/engine/base-merge.ts` and `src/engine/fold.ts`, round 1 ran 63 test files per mutant.
Most of those files never run the mutated line, so they cannot fail because of it (#597).

Node writes the V8 coverage of a process as JSON when `NODE_V8_COVERAGE` names a folder, and the variable propagates to the processes it starts ([NODE_V8_COVERAGE](https://nodejs.org/api/cli.html#node_v8_coveragedir)).
The test runner runs each test file in a child process of its own by default ([process isolation](https://nodejs.org/api/test.html#test-runner-execution-model)), so a run with the variable set leaves one coverage file per test file, naming that test file among the scripts it loaded.
Its own coverage, `--experimental-test-coverage`, reports once for the whole run ([collecting code coverage](https://nodejs.org/api/test.html#collecting-code-coverage)), so it cannot tell which test file ran a line.

Stryker's `coverageAnalysis: "perTest"` is the prior art: it records which tests cover which mutant during the first run and runs only those tests per mutant, and `"all"` reports a mutant no test covers as `NoCoverage` without running it ([coverageAnalysis](https://stryker-mutator.io/docs/stryker-js/configuration/#coverageanalysis-string)).

## Decision
- **One covered round.** The wide list's baseline (ADR 0171) runs once with `NODE_V8_COVERAGE` set to a folder of the scratch. `scripts/mutant-coverage.ts` reads that folder and prints, for each valid mutant's `<file>:<line>`, the test files whose child ran the line, and the file's own test file (`test/unit/<name>.test.ts`, its `-core` and `-shell` forms, and `test/unit/<folder>-<name>.test.ts`, as `mutant-coverage-core.test.ts` for `scripts/mutant-coverage/core.ts`), when the wide list holds it. Each mutant then runs once over those files against that baseline; `scripts/mutant-coverage/core.ts` decides.
- **Per test file, not per test.** The test runner gives no coverage per test case without a reporter of its own that starts and stops V8's profiler around each test, and the mutant runs already take test files. A file that covers the line runs whole.
- **A line ran in a child** when one of its non-blank characters lies in an innermost range with a count above zero. V8 lists a function's range and, inside it, a range for each block that ran a different number of times, so a branch never taken and a function never called read as not run. Type stripping turns types into whitespace, so offsets in the stripped source are offsets in the file; V8 compiles the text after a byte order mark, so the offsets skip it. A line that also declares a function at module level runs on load, so it counts as run in every child that loads the file: more files, never fewer.
- **A mutant killed only by a test that does not run its line is not lost.** Such a test can fail only through something the mutant changed that a covering test also sees, so a covering test fails too.
- **A line no test file runs is not run.** The mutant is reported *not run (no test covers `<file>:<line>`)*, neither killed nor a survivor, as Stryker's `NoCoverage`.
- **What the coverage cannot tell runs more.** A test file of the wide list with no coverage file (it crashed before writing one), or with two, counts as running every line.
- **The fallback is ADR 0171's two rounds.** When no coverage file names a test file of the run (an older Node, `--test-isolation=none`), a coverage file cannot be read, no test file imports the files, a test file's name holds a space or a line break (the list is one line), the coverage baseline times out, or the criteria's copies predate `mutant-coverage.ts` or `mutant-verdict.ts`'s test files (a review of this record's own pull request takes the older verdict script from its base), stage 4 runs the direct and the wide rounds, and the summary says why. Round 2 reuses the coverage baseline when it finished.
- **A verdict reads only the files the mutant ran.** `scripts/mutant-verdict.ts` takes the run's test files after the two outcome files and compares the run with the baseline's outcomes of those files only, so a file left out is not read as a test that stopped reporting (ADR 0040).

## Consequences
- A mutant in a widely imported file runs a handful of test files, not most of the suite (see Verification).
- The baseline is the wide list, larger than ADR 0171's direct list, and coverage slows it; it runs once per review.
- A survivor gets no second round over files that never run its line.
- A mutant that one test kills only by its timing (a test that runs the line in another file's child) is out of reach, as it was for a test outside the wide list.

ADR 0054 turned down both parts of this: a coverage map, since it needs a coverage run first, and a verdict over part of the baseline, since one shared list kept ADR 0040's verdict as it was.
The coverage run is now the one baseline a review runs anyway, and the verdict names the files it reads, so a left-out file is never mistaken for a failed one.
This is the Brett row of [ADR 0241](0241-each-test-runs-at-the-stage-where-it-pays-the-check-runs-the-test-files-a-change-reaches.md)'s table.

## Alternatives considered
- **Per test, as Stryker's `perTest`:** fewer tests per mutant, but a reporter that drives V8's profiler around each test, and the runs would need to name tests, not files.
- **`--experimental-test-coverage`:** one report for the whole run, so it cannot tell the test files apart.
- **Coverage of the direct list only:** a smaller baseline, but a mutant only a file one module away covers would never run.
- **A baseline per mutant over its covering files:** the same outcomes the filtered baseline gives, at one more run per mutant.

## Verification
Measured on 2026-11-02 on a twelve-core Windows machine with other sessions running, Node 24.20, on #593's five mutants at its reviewed head `4809b659`, rebuilt from its review summary and checked valid by `mutants.ts`, in a scratch tree as stage 4 makes it, the runs one after the other with `--test-concurrency=6`.

- **Before** (ADR 0171): `--direct` lists 63 test files, the wide list 103. Direct baseline 52.2 s, the five mutants 39.7–57.4 s each; 314 s in all. Every mutant killed in round 1 (59, 1, 30, 14 and 4 tests), so round 2 never ran, as in #593's review.
- **After** (the covered round): the coverage baseline over the 103 files took 90.7 s (the same files without coverage took 58.6 s, so coverage adds about half) and wrote 103 coverage files, 70 MB; `mutant-coverage.ts` took 2.9 s. The mutants ran 5, 5, 4, 4 and 14 test files, 5.2–15.4 s each; 154 s in all. Every mutant killed (66, 1, 30, 14 and 8 tests).
- The verdicts are the same. The counts of the first and fifth grow, since covering files one module away (`test/unit/merge-brief.test.ts` for the first; `brew`, `intake` and `merge-brief` for the fifth) now run, where round 1 ran only the direct importers.
- The baseline is now most of the stage's time; with more mutants the saving grows, one run of a few files per mutant instead of the direct list.
