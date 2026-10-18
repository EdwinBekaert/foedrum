# 0075. Only a lower bound reads the wall clock, and doctor's tests run against stub tools

Date: 2026-10-18 · Status: Accepted · Amends [0070](0070-tests-never-hold-the-wall-clock-to-a-limit.md) (its two exceptions) and [0073](0073-github-only-through-gh-s-own-login.md) (the integration tests that run doctor)

## Context
ADR 0070 let a test read the wall clock in three cases: a lower bound, a bound that is itself the property (the orphans of #92, which end by themselves after 30 s, so the test gave the kill 10 s), and a product's own wait the test covers (the driver lock's 2 s for a lock let go of 200 ms in). An audit on 2026-10-18 found that the last two still fail on a loaded machine (#212): a kill that lands late or a test process that loses the CPU between two readings of the clock fails the 10 s window, and a child that lets go of the lock late fails the 2 s wait, which SQLite's busy wait stretches to about 3 s on Windows.

The same audit found integration tests whose outcome depends on the machine. `foedrum doctor`'s ran against whatever the machine has (claude, npm, podman or docker) and accepted any outcome, a tool `missing` or any version; on a loaded machine podman timed out at doctor's 3 s and `npm --version` was slow, which hit two sessions that day. The test of `outOfDate` read this checkout's own `node_modules`. The client of the real-gh tests kept its default 30 s deadline.

## Decision
Only a lower bound may read the wall clock: a timer waited at least its time. The other two exceptions go.

- **A bound that was the property becomes an order of events.** The orphans of the process tree add their pid to `<pid-file>.ended` when they end by themselves after their 30 s. The tests wait for the tree to end with `waitUntil`, a guard against a hang, and then check that no level recorded its own end: the kill came first.
- **A product's own wait that a test covers gets only a guard against a hang.** The driver lock test passes `waitMs: hangGuardMs` and proves that `lockDriver` waits for a held lock and takes it once let go, not how long it waits.

doctor's integration tests run its real shell with stub executables on a `PATH` of their own (`test/integration/stub-tools.ts`, `test/fixtures/doctor/tool.ts`): each prints what the real tool printed, and an answer can hang instead. node and git stay real; git gets a global configuration of the test's own and no system one, and its row is checked against its own path and then taken as it is. Each case asserts the exact report: everything present, tools and a login missing, and a container runtime that hangs. The probes run through a runner whose every deadline is `hangGuardMs` (`hangGuardTimers` in `test/helpers/load.ts`); the hanging runtime's deadline comes from `cuedTimers()`, fired once its stub runs. This replaces ADR 0073's canned gh at a made-up path for these tests: the stub gh answers from the same captured output, and nothing reaches a login. Other tests that run doctor or serve keep `cannedGhLogin`.

Test data that a tool writes, such as the record `npm ci` leaves in `node_modules/.package-lock.json`, is captured in a fixture (`test/fixtures/deps-sync/`) and copied into a project of the test's own, never read from the checkout.

Each fix was shown red under a modelled load first, as ADR 0070 asks: the test process descheduled for 3.1 s after doctor starts its probes, a child that lets go of the lock after 5 s, a kill a second late with every reading of `Date.now()` 10.1 s after the one before, and timers that come 30.1 s early for the gh client.

## Consequences
- No test holds the wall clock to a limit that is meant to pass under load any more, so a busy machine cannot fail one by stretching time. A few integration tests still poll for a batch to leave brewing against `Date.now()` with 60 to 120 s; those are guards against a hang in the sense of ADR 0070, written before `waitUntil`.
- The orphan tests wait up to the levels' own 30 s when the kill misses, then fail by the record, not by a window; with `jobObject: false` the Job Object test fails after 30 s.
- No test shows any more that the driver lock's default wait is about 2 s (`WAIT_MS` in `src/engine/driver-lock.ts`); the integration test shows that the wait works across processes, and the unit tests pass `waitMs: 0`.
- doctor's report is checked line by line on each platform, so a change to its wording or order fails the integration test as well as the unit snapshot, and the test needs no tool but node and git on the machine. The stubs cost a node start per probe, and the modelled load costs 3.1 s of wall time per case, no CPU time.
- The real version output of bwrap, socat, podman and docker is no longer read by any test on the machines that have them; what doctor parses is the captured text.

## Alternatives considered
- **Keep the exceptions with longer limits:** a longer window holds until a busier day, and for the orphans it cannot pass 30 s.
- **Stub git too in doctor's tests:** the stubs are `.cmd` files on Windows, and doctor's `git config --get-regexp ^credential\.` cannot go through cmd.exe (ADR 0031), so git would need a native stub.
- **Put all of PATH's tools first and the machine's PATH after:** a tool the stubs leave out would be found on the machine, and the report would depend on it again.
