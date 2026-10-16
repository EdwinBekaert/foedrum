# 0035. The per-file test budget is CPU time

Date: 2026-10-16 · Status: Accepted · Amends [0021](0021-unit-tests-spawn-no-processes.md)

## Context
`npm test` fails when one file in `test/unit/` takes more than 5 s, and when a file in `test/property/` or `test/chaos/` takes more than 15 s (`scripts/test-budget-reporter.ts`, #87). It measured wall time, the only time `node:test` reports per file. A file's wall time grows with the machine's load: `npm run check` runs its steps at once, and several sessions often run on one machine, one of them in a mutation run. On 2026-10-16 both pushes of #102 were blocked by unit files that went over 5 s on load alone, none of them slow on a quiet machine. A gate that fails on load makes unattended sessions wait and retry by hand, and teaches them to re-run it.

The budget is meant to catch a file that is costly, not a machine that is busy.

## Decision
- **The budget and the ceiling are CPU time**: the user and system time of the test file's own process, from `process.cpuUsage()`. The numbers stay: 5 s for a file in `test/unit/`, 15 s for a file in `test/property/` or `test/chaos/`.
- **Each test process reports its own.** `npm test` loads `scripts/test-cpu-time.ts` with `--import`, so node loads it in every test process it starts. There it registers a root `after` hook that sends the process's CPU time as a `node:test` diagnostic, which the runner passes to the reporters with the file's path. The reading covers loading the file and its tests and hooks, but not the file's own root-level `after` hooks, which run later.
- **A file without a reading is held to its wall time**: one that failed to load, or a run without the preload. Wall time is never lower than what the file would have reported on one thread, so a missing reading never lets a costly file through.
- **spec does not show the readings.** `npm test` uses `scripts/spec-reporter.ts`, node's spec reporter without them, so the output gains no line per file.
- The list of the costliest files shows CPU and wall time side by side, so a file that mostly waits can still be seen.

## Consequences
- Load from other sessions or the check's other steps no longer fails the budget, so it no longer blocks a push. A file that does more work than the budget allows still fails `npm test`, `npm run check` and the gate, whatever the load.
- A file that only waits (real timers, a slow disk) passes, however long it takes. The 20 s goal for the whole check, the list's wall column and review catch that.
- The budget no longer catches a process that slipped into a unit test: the process's CPU time is its own, and waiting for it costs the test process almost none. The test-layer guard (`scripts/check-test-layers.ts`) still catches a test that imports `node:child_process` or the process runner; one that starts a process through a module it imports is left to review, until the preload also refuses process starts in the layers `npm test` runs (a follow-up).
- CPU time is not quite load-free: on a machine with simultaneous multithreading, a busy sibling core makes the same work take more CPU time. The effect is much smaller than the queueing that stretches wall time, and the budget keeps its margin (the costliest unit file used about 3.5 s on a quiet machine).
- Garbage collection and coverage threads count, so a file's CPU time can be higher than its wall time.
- `npm test` depends on two more files and on `node:test` passing a root `after` hook's diagnostic on with the file. The integration test runs the reporters and the preload under the real runner and fails when that changes.

## Alternatives considered
- **Re-run the over-budget files once and fail only when they are over again:** simple, but it still depends on the load, and a loaded machine stays loaded for the second run.
- **Scale the budget by the load average:** `os.loadavg()` is always zero on Windows.
- **Write each process's reading to a file for the reporter:** works without hiding diagnostics from spec, but needs a folder shared between the runner and its processes, and files left behind when a run stops.
- **Fail the file from inside its own process, in the after hook:** no reporter change, but the reporter could no longer list or compare the files' times, and a failed hook reads as a failed test.
