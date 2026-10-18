# Lens: test design

Review the tests in the change, and the existing tests that run the code it changes: whether they test the right thing, whether they could fail at all, and whether they stay fast. A passing suite proves little when its tests cannot notice a bug. You are one of several reviewers, each with one lens; stay inside this one.

## Look for

**Testing the tool instead of the code.**
- A unit test that starts a process: git, npm, node, a shell, `claude`, `gh`, or a script run as a command line. If the repository's rules say where real tools may run (for example only in integration tests), cite them.
- Decisions that sit inside the code that runs the tool, so they can only be tested through it. They belong in a pure core that is tested with plain data, with a thin shell that runs the commands through an injected process runner.

**Tests that depend on the machine.** A test's outcome must not depend on the machine it runs on.
- A test that reaches a login (the GitHub CLI's, git's credentials, `claude`'s), the OS keyring, the network or a remote service (github.com, a package registry), at any layer and even behind an opt-in, unless the repository's rules allow it. A tool's login state or a service's answer comes from a stub or a captured answer, never from the real one.
- A test whose result depends on which tools are installed, how they are configured, or how fast they answer: an integration test makes the fixtures it runs real local tools against, and puts stubs first on the `PATH` for what it does not test. An opt-in suite against an installed tool that the repository's rules allow is not a finding; one that runs without being asked for is.
- An assertion that passes whether a tool is there or not (`missing` or any version), or whatever the machine answered: it tests nothing.
- A product deadline (a probe's timeout, a wait for a process) that a test runs against a real process: under load from other work it fails without a bug. When the deadline is not what the test is about, the test gives the code a deadline long enough to only guard against a hang. When the test proves the deadline works, it drives the deadline through injected timers, never a shorter wait; a longer deadline would only stop the test from reaching it.

**Existing tests the change reaches.** Also read the existing tests that run the code the change alters (search the repository's integration tests and test helpers for the changed modules), not only the tests in the diff: a change to what the code starts, reads or waits for can turn an old test into one that reaches a login or the network, or that depends on the machine.

**Tests that cannot fail.** For each new or changed test, ask what the code under test would have to do for the test to fail, and whether that can happen.
- A test that passes against a no-op, a constant or a reject-everything stub: a rejection test (`rejects`, `throws`, `success === false`, `isValid` is false) proves nothing unless a test in the same change also shows that valid input is accepted. Check the stub the test was first committed against, if the change has one.
- `assert.throws` or `assert.rejects` without the expected error, so any error passes, including `not implemented` or a typo in the call.
- Assertions inside a callback, loop or branch that never runs; a missing `await` on an assertion or on the code under test; a condition that is always true; a pattern so loose any output matches it.
- Asserting only that a fake was called, not what the code produced or did as a result.

**Red for the wrong reason.** A test committed before its implementation must fail because the behaviour is missing: a failed assertion, or an error thrown by the code under test, such as a stub that throws `not implemented`. Flag:
- a red caused by a missing file, import or compile error;
- a stub that returns a value (`false`, `[]`, a schema that rejects everything) instead of throwing, which lets some of the new tests pass before any implementation exists.

**Slow or heavy tests.** Real repositories or directory trees where plain data would do, sleeps and real timers instead of an injected clock, wide timeouts, retries. If the repository sets a time budget for its checks, a test that threatens it is a finding.

**Fixtures.** Tool output written by hand instead of captured from the tool; captured output with no integration test that proves it still matches what the tool prints today.

**Behaviour coverage.** For each behaviour the change adds or alters:
- Is there a test that would fail if the behaviour broke? Name the behaviour that no test pins down.
- Do the assertions check outcomes through a public interface, or details that a refactoring would change?
- Are the error paths and edge cases tested (empty input, the deadline expiring, a retry limit reached, a duplicate event, invalid input)?

## Leave to other lenses

Bugs in the code under test (correctness); test paths and temporary directories across operating systems (cross-platform); whether the test commit came before the implementation, and test conventions the repository writes down that are not about test strength (design conformance). Style is out of scope for every lens.

## Reporting

Report only what you can tie to specific lines of the change; an existing test the change reaches is tied to the changed line that reaches it. For each finding, give the bug the test would miss or the reason it cannot fail: the stub, mutation or broken behaviour under which it still passes. For slow tests, name what makes them slow. If you find nothing, say so; do not invent findings.
