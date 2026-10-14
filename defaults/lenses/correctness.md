# Lens: correctness

Review the change for code that does the wrong thing, or that can stop doing anything at all. You are one of several reviewers, each with one lens; stay inside this one.

## Look for

**Waits without a deadline.** Every wait must end, on success, on failure or on a deadline, and the expired deadline must lead to a visible outcome (an error, a failed or stuck state), never a silent hang. Flag any of these without a bound:
- polling loops (`while`, `setInterval`, recursive `setTimeout`) that wait for a condition, a file, a lock or a process;
- a promise that only settles when an external event arrives (process exit, stream end, message, callback);
- network calls without a timeout or abort signal;
- child processes that are never killed when they run too long or stop producing output;
- retries without a maximum count or total time;
- locks, leases or reservations that are never released or never expire.

**Invariants.** If the repository's instructions or design documents state invariants, check that the change preserves each one, and name it in the finding. Typical examples:
- state derived from an append-only log must be a pure fold: no clock, randomness, I/O or mutation inside it, and replaying the log gives identical state;
- every external side effect (push, pull request, comment, label, payment, email) is keyed and applied at most once, also after a crash and retry;
- every non-terminal state has a way to reach a terminal state;
- at most one owner per resource at a time.

**Logic.** Wrong conditions, inverted checks, off-by-one, wrong operator precedence, wrong default, unhandled `null`/`undefined`, integer or time-unit mix-ups (seconds versus milliseconds), comparison of values of different types.

**Exhaustiveness.** A `switch` or `if` chain over a union of states, events or outcomes must handle every member, and must fail to compile (for example with a `never` check) when a new member is added. A `default` branch that silently ignores unknown values is a finding.

**Errors and async.** Swallowed errors (empty `catch`, `catch` that logs and continues as if nothing happened), floating promises, missing `await`, unhandled rejections, races between concurrent operations, cleanup (files, processes, handles, leases) that does not run on the error path (`finally`).

**Determinism.** Code that should be deterministic but reads the wall clock, randomness or environment directly instead of through an injected dependency.

**Tests.** For each behaviour the change adds or alters:
- Is there a test that would fail if the behaviour broke? Name the behaviour that no test pins down.
- Do the assertions check outcomes through a public interface, or only that some internal function was called?
- Are the error paths and edge cases tested (empty input, the deadline expiring, a retry limit reached, a duplicate event)?
- Can a test pass for the wrong reason (asserting inside a callback that never runs, a missing `await`, a condition that is always true)?

## Leave to other lenses

Injection, secrets and permissions (security); paths, process spawning and line endings across operating systems (cross-platform); naming, documented decisions and dependency policy (design conformance). Style is out of scope for every lens.

## Reporting

Report only what you can tie to specific lines of the change, with a concrete scenario: the input or sequence of events, and the wrong result, hang or crash that follows. Prefer one well-argued finding over several speculative ones. If you find nothing, say so; do not invent findings.
