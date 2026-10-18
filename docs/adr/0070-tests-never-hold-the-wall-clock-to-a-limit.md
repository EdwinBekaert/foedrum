# 0070. Tests never hold the wall clock to a limit

Date: 2026-10-17 · Status: Accepted · Extends [0036](0036-test-budget-in-cpu-time.md)

## Context
Several sessions often run on one machine, and `npm test` and `npm run test:integration` run below normal priority (ADR 0054), so a test process regularly loses the CPU for seconds. On 2026-10-16 and 17 five tests failed in full runs while other sessions ran, and passed on their own (#147). Three sessions lost a rerun to them, and the gate blocked a push:

- `claude-stream.test.ts` checked that a long shell command is read in linear time against 200 ms of wall time. Under load it took 352 ms; with coverage and 24 CPU-heavy processes beside it, 2.4 to 3 s, in 3 runs of 6.
- `claude-runner.test.ts` checked that `waitFor` answers at once after an abort as less than 1000 ms of wall time.
- `git.test.ts` and `worktrees-clean.test.ts` gave git a 2 or 3 s deadline, which raced the start of git's shell and node, and then gave the kill 2 or 5 s to take effect. The kill starts `taskkill` on Windows, or sends SIGKILL after a grace, so on a busy machine it lands late.
- `processes.test.ts` gave a tree of three node processes 8 s to start before its deadline, gave the kill 10 s, and checked "answers at once" against 5, 10 or 15 s of wall time in six tests.

Each of them compared wall time with a fixed limit. Wall time measures the machine's load as much as the code. Raising the limits would only move the line until the next busier day, and a limit long enough for any load proves little. ADR 0036 made the same call for the per-file test budget.

## Decision
A test never asserts that something took less than a fixed amount of wall time, and never gives a process or a timer a fixed time to have happened. What it uses instead depends on what it proves:

- **That a deadline or a timer works:** the code takes its clock or timers as a dependency (`Timers` in `src/platform/processes.ts`, `timers` in `waitFor`), and the test drives them. `cuedTimers()` in `test/helpers/load.ts` fires the deadline when the test calls `fire`, so an integration test reaches a process runner's deadline once the processes it is about are running, however late a loaded machine starts them. A unit test can use `node:test`'s mock timers.
- **That something answered at once:** show it with an order of events, not a duration. The result settles before the event loop turns again (a race against `setImmediate`); or the runner answers while the processes it killed still run, because `lateKill(ms)` (`test/integration/late-kill.ts`) carries the kill out late; or a deadline that never comes shows that the limit, not the deadline, ended the process.
- **That something ends:** wait for it with `waitUntil`, which polls the condition and fails only after `hangGuardMs` (120 s). That is a guard against a hang, never a measure, so it is long.
- **That something is fast enough (a performance property):** measure CPU time, `cpuTimeMs()` (from `process.cpuUsage()`), which load from other processes leaves alone.

A lower bound (a timer waited at least its time) may read the wall clock: load only makes it longer. So may a bound that is itself the property, such as the orphans of #92, which end on their own after 30 s, so the test must see them killed within less than that; and a product's own wait that the test exists to cover, such as the driver lock's 2 s for a lock let go of 200 ms in.

Each fix is shown red first under a load that the test models: `descheduled(ms)` blocks the test process for that much wall time without using the CPU, as the OS does on a busy machine; a mocked `Date` that jumps past the limit; a deadline shorter than any machine starts a process in; or a kill carried out late. The model stays in the test where it costs no CPU time, so the test keeps showing that it does not depend on the wall clock.

## Consequences
- These tests no longer fail on a loaded machine, so they no longer block a push or cost a rerun. Each still fails when the behaviour it proves breaks: a runner that waits for the processes it killed sees them still running; a deadline that does not end the tree leaves it running past `waitUntil`; a parse that turns quadratic uses seconds of CPU time.
- A regression that makes something slow but not stuck (a runner that answers a few seconds late) is no longer caught by a test that waits with `waitUntil`, only by one that proves an order of events. The tests that claimed "at once" now all prove an order.
- A test whose deadline never comes would hang if the code under test broke, so it takes `{ timeout: hangGuardMs }`.
- The loads cost wall time but no CPU time, so the per-file budget (ADR 0036) does not count them: about 1.4 s in two unit files, and 2.5 s for each test with a late kill in the integration suite.
- CPU time is not quite load-free (ADR 0036): a busy sibling core on a machine with simultaneous multithreading makes the same work take more of it. The linear-time check keeps its 200 ms against a parse that takes a few ms.

## Alternatives considered
- **Raise the limits:** they would hold until a busier day, and a limit long enough for any load proves nothing about "at once".
- **Retry a failed test once:** the machine is still loaded on the second run, and a real failure then costs twice as long to see.
- **Skip the timing tests when the machine is busy:** they would stop running exactly when sessions work in parallel, and the load average is always zero on Windows (ADR 0036).
- **Compare the time of twice the input with the time of the input** for the linear-time check: both readings carry the load, and the ratio is noisy at a few ms.
