# 0250. The supervisor is one tick: the commands that run the driver own the interval

Date: 2026-10-28 · Status: Accepted · Amends [0027](0027-supervisor-lost-and-stalled-attempts.md) (the shell runs one tick, not a loop on an interval, and the `StateBranchStopError` stop holds through `tick()`) and [0063](0063-foedrum-serve-its-configuration-and-wiring.md) (serve's step 5: the 5 seconds are serve's own interval, not the supervisor's)

## Context
[ADR 0027](0027-supervisor-lost-and-stalled-attempts.md) gave the supervisor's shell (`src/engine/supervisor-loop.ts`) a loop: `run()` ticked on an injected `Timer` every `intervalMs` (default 5 s) until `stop()`, and rejected with a `StateBranchStopError`.
No production code ran that loop (#616).
The driver ([ADR 0044](0044-batch-leases-held-by-the-driver-and-one-command-log.md)) calls `supervisor.tick()` from its own tick, and the commands that run the driver wait between ticks themselves: `foedrum serve` ([ADR 0063](0063-foedrum-serve-its-configuration-and-wiring.md)), `foedrum brew` ([ADR 0123](0123-foedrum-brew-drives-one-batch-under-an-owner-of-its-own.md)) and the takeover of `foedrum resume` ([ADR 0127](0127-foedrum-resume-takes-a-running-batch-over-and-continues-its-step-s-session.md)).
`driver.close()` stopped a loop that never started.
ADR 0063 still called serve's 5 seconds "the supervisor's interval (ADR 0027)".

## Decision
- The supervisor is one tick: `createSupervisor` returns `tick()` only.
  `run()`, `stop()`, the `Timer` it scheduled on and the `timer` and `intervalMs` options go, with their tests; `driver.close()` no longer stops the supervisor.
- The commands that run the driver own the interval between ticks: `foedrum serve` (its `INTERVAL_MS`, 5 s), `foedrum brew` and the takeover of `foedrum resume`.
  Each awaits a tick before it waits for the next, reports a tick that throws as `tick_failed` and runs the next one.
- `tick()` still waits for the tick in flight, so ticks never overlap, whoever calls them; a `report` that throws is still ignored, so it cannot end a tick.
- A `StateBranchStopError` stops the engine through `tick()`: the tick rejects with it, and the command that runs the driver stops without another tick.
- This amends ADR 0027's shell bullet and its `StateBranchStopError` bullet, and ADR 0063's step 5: serve ticks the driver every 5 seconds on its own interval.

## Consequences
- `src/engine/supervisor-loop.ts` loses its loop and its real timer; `test/unit/supervisor-loop.test.ts` loses the `run` tests and keeps the waiting for the tick in flight and the ignored `report` as tests of `tick()`.
- The stop at a `StateBranchStopError` is shown by `tick()` rejecting with it and by `foedrum serve` stopping on it, tests that were there before this change.
- A future caller that needs ticks on an interval writes its own loop around `driver.tick()`, as the three commands do.
