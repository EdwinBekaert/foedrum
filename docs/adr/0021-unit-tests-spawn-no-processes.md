# 0021. Unit tests start no processes

Date: 2026-10-15 · Status: Accepted · Amended by [0036](0036-test-budget-in-cpu-time.md)

## Context
`npm run check` took 65–85 s on Windows by the end of M0's second wave, and every push runs it again. Most of that time is tests that start real processes: git repositories built per test, the gate hook run through bash and npm, scripts run as CLIs. Starting a process costs tens to hundreds of milliseconds on Windows, git commands are several processes each, and the engine will grow many more such tests (worktrees, the state branch, the brewer runner). At that rate the suite reaches tens of minutes, and slow tests are skipped, batched or made flaky by timeouts.

Such tests mostly check that git, npm and bash work. Foedrum's own logic, what to run and how to react to the answer, can be tested without them. The architecture's test layers (§9) did not say where real processes belong.

## Decision
- **Unit tests never start a process** (git, npm, node, bash, `claude`, `gh`). Code that runs commands takes an injected **process runner**, as CLAUDE.md already requires for the clock, `fetch` and the brewer runner.
- Code that drives git or another tool is split in two:
  - a pure **core** that decides, from facts, what to do (for example: these worktrees are merged and unlocked, so remove them);
  - a thin **shell** that gathers the facts and executes the decisions through the runner.

  The core is tested with plain data, and the shell with a fake runner that records the commands and returns recorded output. Parsers of tool output (`git worktree list --porcelain`, `npm` JSON) are tested against captured output stored as fixtures.
- **Integration tests** run the real tools. They live in `test/integration/`, run with `npm run test:integration`, and are not part of `npm run check`. CI runs them on all three operating systems, and so does the nightly run. Each tool boundary gets a few of them, enough to prove the shell's commands work against the real tool and that the fixtures still match its output, not one per behaviour.
- **Budget:** `npm run check` stays under 20 s on a developer machine. A test file that needs more is a sign that a process or a real file system tree slipped into a unit test.
- Tests that use the real file system for what they test (the platform layer's robust remove, read-only folders) stay unit tests when they start no process and finish quickly.

## Consequences
- The red → green loop stays fast, so running the full check before every push remains affordable.
- Shells must be thin enough to trust after a few integration tests; logic that creeps into a shell is a review finding.
- Recorded fixtures can go stale when a tool changes its output; the integration tests are what catch that.
- Existing tests that start processes (the gate hook, the secret scan and dependency guard CLIs, the worktree cleanup) are moved or rewritten in a follow-up.

## Alternatives considered
- **Real tools in every test:** the most realistic, but slow, flaky under parallel load and dominated by the tools' behaviour rather than Foedrum's.
- **Mocking modules (`child_process`):** ties tests to implementation details; an injected runner is an explicit interface instead.
- **Running slow tests only in CI:** keeps the loop fast but leaves the logic untested locally until a push.
