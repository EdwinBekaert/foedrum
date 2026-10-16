# 0035. The process runner kills a process at an output limit

Date: 2026-10-16 · Status: Accepted

## Context
The process runner (`src/platform/processes.ts`, #12) collects everything a child writes: each chunk is appended to `stdout` or `stderr` and to `output`, so it is held twice, with no limit. Before #84 the worktree cleanup ran git through `execFile`, which stopped at `maxBuffer` (1 MiB by default); the runner dropped that bound.

Commands run against untrusted repository content can write far more than any caller needs before their deadline: a large `git diff` or `git log -p`, a hook or credential helper that writes without end, a brewer's `claude` stream. A call without a `timeoutMs` has no deadline at all. Measured before this change, a node process writing 64 KiB at a time made the runner throw `RangeError: Invalid string length` after about 2.7 s on Windows, when the collected string reached V8's limit, as an uncaught exception that would have crashed the engine, the gate or the SessionStart cleanup, with the writer left running (#91).

The runner's callers today write little: `npm run check`, the largest, writes about 150 KB; no git call reads a file's content or a whole log.

## Decision
- `ExecOptions` and `RunOptions` take `maxOutputBytes`, default `DEFAULT_MAX_OUTPUT_BYTES` = 4 MiB, about 27 times what `npm run check` writes. The limit counts the bytes of stdout and stderr together, as decoded text, because that is what the runner holds.
- When a chunk takes the total past the limit, the runner drops that chunk and kills the tree exactly as at the deadline: `killTree`, stop reading both pipes, answer at once with `exitCode: null`. The result keeps what came within the limit and says `killed: 'too-much-output'`, a third `Killed` beside `timed-out` and `stopped`. Writing exactly the limit is fine.
- `whyKilled(killed, timeoutMs, maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES)` says `wrote more than 4 MiB of output`, so a caller that keeps the default needs no change to name it. `runGit` adds `git wrote more than 4 MiB of output` to stderr, as it adds its timeout.

## Consequences
- The runner's memory is bounded for every caller, with or without a deadline, and a runaway writer stops at once instead of running on to its deadline.
- A caller never mistakes cut output for complete output: a killed process has no exit code, and every caller already treats `null` as a failure.
- A command that legitimately writes more than 4 MiB fails, and its caller must pass a larger `maxOutputBytes` (or read the output as a stream). The real brewer runner (#11) is the first such caller: a long session's stream-json can pass 4 MiB, so it chooses its own limit, or parses the stream as it comes and keeps only the facts ADR 0028 names. How a kill at that limit ends an attempt is a fact and a row in ADR 0028's table, decided with #11.
- Messages (deps-sync, the gate) still cut the output they print themselves; the runner does not shorten what it returns below the limit.

## Alternatives considered
- **Keep only the last N bytes and let the process run on:** what `deps-sync` does for its message. It bounds memory, but a caller that parses stdout (`git worktree list --porcelain`, JSON) would read a cut-off text that looks whole unless it also checked a flag, and a writer without end would keep a CPU busy until its deadline, or for ever without one.
- **Keep the first N bytes and let the process run on:** the same two problems; only the part of the output kept differs.
- **No default, a limit only where a caller asks:** leaves the next caller as exposed as the current ones are.
- **A larger default (64 MiB or more):** fits more legitimate output, but the gate and the cleanup would hold that much twice before stopping, and no caller needs it.
