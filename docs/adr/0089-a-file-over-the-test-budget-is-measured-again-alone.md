# 0089. A file over the test budget is measured again alone

Date: 2026-10-20 · Status: Accepted · Amends [0036](0036-test-budget-in-cpu-time.md)

## Context
ADR 0036 made the per-file test budget CPU time because it expected CPU time not to grow with load, apart from a small effect of simultaneous multithreading. It grows a lot. `test/unit/serve.test.ts` uses 1.3–1.9 s of CPU time alone and went over its 5 s budget in the check of #236 (5.06 s) and twice in the gate of #250 (5.03 s and 5.11 s), each time with nothing wrong in the file (#248).

Measured on a 13th-gen Intel Core i7-1355U (2 performance cores with hyper-threading and 8 efficiency cores) under Windows 11, with a second `npm run check` running as load:

- `serve.test.ts` used 1.26–1.89 s of CPU time alone and 4.08–5.08 s under load, through `npm test`'s own preload and budget reporter, with coverage.
- The rise is spread over its tests and follows the work they do, not the time they wait. The test that waits longest (2.1 s of wall time under load, `ticking` with a 1 ms timer between ticks) used 94 ms of CPU time both alone and under load; tests that never touch a real timer went from 47 to 109 ms. Nothing in the file polls or spins.
- A fixed amount of single-threaded work, hashing in a loop, used 0.6–0.8 s of CPU time alone and up to 4.2 s under load at below-normal priority (up to 2.8 s at normal priority). `process.threadCpuUsage()` gives the same for the main thread alone, so it is not garbage collection or coverage threads: the same instructions take longer on a busy machine, on an efficiency core, at a lower clock, or beside a sibling hyper-thread.
- Other unit files rise the same way: in one loaded run `supervisor-loop.test.ts` used 3.52 s (0.70 s alone), `driver.test.ts` 2.86 s (0.67 s alone), `github-reads.test.ts` 2.52 s (1.45 s alone). `serve.test.ts` goes over first only because it is the costliest unit file.

So no unit file can be held to its CPU time in a loaded run without failing pushes at random, and the load that matters most is the check's own: `npm test` runs a file beside its other files and beside the check's other steps.

## Decision
- **A file over the budget or the ceiling in the run is run again alone**, once the run has ended, one file at a time: `node --import ./scripts/test-cpu-time.ts --test --experimental-test-coverage --test-reporter=tap <file>` in the folder `npm test` runs in, through the process runner, with a deadline of 60 s, and the budget reporter reads the CPU time the file reports in that run's output. A run that was killed, or reports no CPU time, gives no reading.
- **Up to three runs, and the lowest reading counts**, the run's own included. Load only adds CPU time, so the lowest reading is the closest to the file's own work. The runs stop at the first reading within the limit; other sessions' load can outlast the run, and under a second check one run alone of `serve.test.ts` still used 4.34 s.
- A file that is within the limit alone passes, and the reporter says so in one line, with both readings: `ℹ <file> used <run> of CPU time in the run, over the 5 s budget, and <alone> alone: the same work takes more CPU time on a loaded machine (ADR 0089)`. A file over it in every run fails with its lowest reading and the run's.
- A file without a CPU time in the run is held to its wall time as before, and not run again.
- The budget stays 5 s and the ceiling 15 s. The reporter runs the files itself (`nodeRemeasure` in `scripts/test-budget-reporter.ts`); the runner's process starts nothing else, and the test processes, which load the same module, never load the process runner.

## Consequences
- A file that does its work within the budget no longer fails a push because the check, or another session, loaded the machine while it ran. A file that does more work than the budget allows fails alone too, three times, and still fails `npm test`, `npm run check` and the gate.
- A file over the limit costs the run its time alone up to three times more: a few seconds for a unit file, up to three times 15 s of CPU time for a property or chaos file that is really over its ceiling. Files within it cost nothing more.
- A machine loaded through all three runs alone can still fail a file that is near its budget. The runs alone come after the check's own steps have mostly ended, so only other sessions' load is left.
- The second runs repeat the file's tests, so a test that fails at random can fail again there; its result does not count, only its CPU time.
- ADR 0036's consequence that simultaneous multithreading makes "much smaller" a difference no longer holds: on a hybrid CPU the same work took up to seven times the CPU time.

## Alternatives considered
- **Make `serve.test.ts` cheaper:** it would pass for now, but every unit file rises by the same factor, and the next costliest would go over next.
- **Scale each reading by a speed probe run in the test process:** a probe needs a reference speed that differs per machine, `process.cpuUsage()` counts in 15.6 ms steps on Windows, so a probe precise enough costs about as much as the file, and a probe at one moment does not tell on which core the rest of the file ran.
- **Run the tests at normal priority again:** under load the fixed work still used up to 4.6 times its CPU time alone, and ADR 0054's reasons for below-normal priority stay.
- **Raise the budget:** it hides the load instead of measuring past it, and a file that grew costly would pass longer.
- **Re-run once, as ADR 0036 rejected:** one run alone still read 4.34 s for `serve.test.ts` under a second check.
