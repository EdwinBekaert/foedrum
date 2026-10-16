# 0047. The `claude` brewer runner: its stream, its endings and its progress

Date: 2026-10-16 · Status: Accepted · Amends [0027](0027-supervisor-lost-and-stalled-attempts.md), [0028](0028-brewer-runner-outcomes-environment-and-test-first.md), [0042](0042-the-claude-command-line-and-stream-contract.md) and [0046](0046-only-the-runners-settings-the-init-check-and-a-line-by-line-stream.md) · Amended by [0048](0048-proven-claude-versions-retried-pre-stream-failures-and-out-doc-identity.md)

## Context
[ADR 0046](0046-only-the-runners-settings-the-init-check-and-a-line-by-line-stream.md) settled the three questions that blocked a real brewer runner: only the runner's settings load, the init event is checked first, and `streamProcess` reads a stream line by line. This is the runner itself (#11, part 2), with the rest of the consultant's list ([#11, comment](https://github.com/EdwinBekaert/foedrum/issues/11#issuecomment-6215999983)): reading the stream over the captured fixtures, `is_error`, failures before the first model reply, the stall watchdog's signal, prompts on stdin and Job Objects. Two follow-ups of the review of #127 (#128) touch `streamProcess`: a program given stdin without a pipe runs without its prompt, and on Windows a stream without a Job Object can kill an exited pid.

## Decision

### The runner
- `claudeBrewerRunner` (`src/brewers/claude-runner.ts`; `claudeBrewerRunnerWith` takes the stream process, the files and the clock, for tests) implements `BrewerRunner` (ADR 0028). The engine prepares each attempt through a `plan(attempt)` callback: the worktree, the brewer's environment, the prompt, the `claude` call (model, effort, `maxTurns`, tools, session) and the permissions. The runner then:
  1. writes the attempt's settings file from `attemptSettings` (ADR 0046) and builds the command line with `claudeArgs`;
  2. starts `claude` through `streamProcess` with the prompt on stdin and `jobObject: true`. The prompt is a `BrewerPrompt`, a type only `assembleBrewerPrompt` makes (ADR 0041), so no other text can become a prompt;
  3. hands each line to the stream reader below, and stops the process at the line the reader says to stop at;
  4. reads the out doc, at most 1 MiB, only a regular file and only inside the worktree, and settles through `settleAttempt`, as the fake does. A link, a linked folder on the path (a junction needs no privilege on Windows) or `..` could point the out doc, and so the event log, at any file of the machine: the runner refuses a link, compares the real paths of the out doc and the worktree, opens the file with `O_NOFOLLOW` where the platform has it, and checks the opened file again. A hard link keeps its name inside the worktree while its content may be any file of the volume, so a file with more than one link is not read either.
- A plan that fails, a settings file or command line that cannot be built, or a stream process that throws is a process that could not start. A stop before the process started is a stop, also while the plan is still being prepared: the runner does not wait for a plan that may never come.
- `AttemptEnd` carries the session the init showed (id, full model id, CLI version) next to the usage, for ADR 0019's resume. The session id is the one the plan chose, so the engine can record it before the attempt starts. This amends ADR 0042's "the runner creates the session id" (and ADR 0046's "the one the runner chose"): the engine chooses it, because a resume needs it from the engine anyway.
- The runner reports progress for each attempt it runs and nothing once it ended. It renews no lease: the driver does ([ADR 0044](0044-batch-leases-held-by-the-driver-and-one-command-log.md)).
- A stream line may be 8 MiB: an event can hold a whole file the brewer read.

### Reading the stream
`readClaudeStream` (`src/brewers/claude-stream.ts`) is pure: it takes each line with the time it came, and answers `go` or `stop`.

| Line | Before init | After init |
|---|---|---|
| empty | skipped | skipped |
| not a JSON object with a `type` | the garbage fact (the first one, cut to 200 characters) | the same |
| `system` other than `init` (`ui_invalidate`, `thinking_tokens`) | skipped (ADR 0046) | skipped |
| `system/init` | `checkInit`; a mismatch is the `environment` fact and **stop** | ignored |
| `result` | the `environment` fact: *claude ended before the session started* (a missing session to resume, no sandbox) | how the run ended: `num_turns`, `usage`, and `is_error` |
| any other event | a mismatch (the stream does not start with `init`) and **stop** | read as below |
| `system/permission_denied` | | one denial (`noteDenial`); **stop** at the one that reaches `maxDenials`, and read nothing after it |
| `assistant` with `error` | | before the first model reply, and only for a lasting cause (`model_not_found`, `authentication_failed`, `billing_error`, `invalid_request`), the `environment` fact: *claude failed before the model replied*. A rate limit, a failing or overloaded server and an unknown error may pass: the result's `streamError` then decides, retryably |
| `assistant` | | a model reply; a turn per message id of the main thread (`parent_tool_use_id` is `null`) |
| `user` | | tool results, for progress |
| every other type | | ignored, also types claude adds later |

- **`is_error` decides** (ADR 0042). An error result after the model replied is the new `streamError` fact, its `terminal_reason` (or subtype) and its first error or text, cut to 200 characters: `max_turns: Reached maximum number of turns (1)`. An error result names no cause the runner can tell apart, so it is never the environment by itself, also before the first reply: an overloaded API on the first request may pass.
- **Turns** are the result's `num_turns` once it came, and the main thread's message ids until then.
- **Arguments claude refused** end with an exit code other than 0 before any line (ADR 0042). The runner makes that the `environment` fact, *claude refused to start*, with the last line of stderr cut to 200 characters. A code past 255 is a Windows crash status (NTSTATUS), which claude never exits with: a crash, retried, as a signal is on macOS and Linux.
- **Commands are read in linear time.** The commit check splits a command at its separators and looks for `commit` after `git` in each part, with no pattern that can backtrack: the command is model output, and a slow check would hold the engine's timers.

### How an attempt ends
ADR 0028's table, as amended by ADR 0046, gains three facts. The first rule that applies wins:

| Facts | Ending |
|---|---|
| claude did not set up the session that was asked: a mismatched init, a result before init, a lasting error before the first model reply, refused arguments | `blocked` + `environment` (Stuck at once) |
| The process could not start | `failed`, not retryable |
| Denials reached `maxDenials` | `blocked` + `environment` |
| Turns past `maxTurns` | `failed`, not retryable |
| Stopped by the runner within its limits | `cancelled` |
| Killed by a signal the runner did not send (on macOS and Linux a crash or the OOM killer closes the process with a signal and no exit code; `streamProcess` reports the signal) | `failed`, retryable |
| **Output past a limit of the runner** (a stream line past 8 MiB, stderr past 4 MiB) | `failed`, retryable |
| **The result reported an error** (`is_error`), whatever the exit code | `failed`, retryable |
| Exited with another code than 0 | `failed`, retryable |
| A stream line that is not stream-json | `failed`, retryable |
| **The runner did not read the out doc** (past 1 MiB, not a regular file, more than one link, outside the worktree), or there is none, or it is invalid | `failed`, retryable |
| Out doc `done` · `needs_input` · `blocked` · `failed` | as ADR 0028 |

- An unknown model, a missing login, a session that cannot be resumed and a sandbox that cannot start all fail before the model replies, and the next attempt would fail the same way: the consultant's item 4. They go to the environment lane instead of spending attempts as crashes.
- An error that may pass (an overloaded API, a rate limit, a dropped connection) is retried, before the first reply as after it.
- Output past a limit is retried: the next attempt may not read the same file.

### Progress for the stall watchdog
- ADR 0027's stall is *no file write or commit for N turns or M minutes*. The runner reads both from the stream: a `Write`, `Edit`, `MultiEdit` or `NotebookEdit` call, or a `Bash` or `PowerShell` command that runs `git … commit`, whose result came back without `is_error`. Its time is `lastProgressAt`, and `turnsWithoutProgress` counts the turns since then. Before any, `lastProgressAt` is the start of the attempt.
- System events (`thinking_tokens`, `api_retry`), `rate_limit_event`, reads and failed writes never count, as the consultant recommended. The consultant's item 6 counted every assistant and tool event as progress; that would make a brewer that reads in circles look busy forever and leave the turn limit nothing to count, so the runner keeps ADR 0027's meaning.
- A brewer that changes files only through other shell commands (`sed -i`, a code generator) shows no progress until it commits; a step whose brewer works that way sets its `stall` limit with that in mind.

### `streamProcess` (#128)
- **Only in a Job Object on Windows.** Where the spawner can hold a Job Object (Windows), `streamProcess` without `jobObject: true` starts nothing and answers as not started. Between the direct child's exit and the close of its pipes (a grandchild still holds stdout), a kill would use an exited pid, which `taskkill /T` cannot follow to the grandchildren and which may belong to another process by then. A kill-on-close job holds the whole tree whatever its pids. Elsewhere the option is ignored and the runner kills the process group.
- **No stdin pipe, no run.** When `stdin` is given and the child has no pipe for it, the runner kills the tree and answers as not started: the program would otherwise run without its input.

## Consequences
- The fixtures of #17 are the reader's tests, and the runner is tested end to end against the installed `claude` with the fake Messages API (`test/integration/claude-runner.test.ts`): a brewer that writes its out doc, and one stopped at `maxDenials`. Like `claude-cli.test.ts` they are skipped where `claude` is not on PATH, which includes CI.
- The engine does not build a plan yet: `foedrum serve` has no runner. A follow-up connects the driver's attempts to the brewer definitions, the attempt worktrees ([ADR 0037](0037-attempt-worktrees-in-the-engine-and-driver-locks.md)), `buildBrewerEnv`, `assembleBrewerPrompt` and the session to resume.
- Not in this decision, left to follow-ups: native `claude.exe` first, with doctor reporting a `.cmd`-only install (the consultant's item 8); a login kept in the user's settings file (ADR 0046); the `claude` version range the settings proof ran against, and the CLAUDE.md rule to kill only by pid (#128); the repository's instructions for `context: repo` (item 9); the sandbox on macOS, Linux and WSL2 (item 10); a recapture test (item 11).
- A `streamProcess` caller on Windows always pays the Job Object helper's start-up, about 0.4 s (ADR 0039). A brewer attempt takes minutes.

## Alternatives considered
- **Document why a caller may do without a Job Object on Windows**, instead of refusing: no caller needs to, and a refusal cannot be forgotten.
- **Every assistant and tool event as progress** (the consultant's wording of item 6): see above.
- **Read file changes from the worktree** (`git status` on a timer) instead of from the stream: it sees every way of writing a file, but costs a git process per check and per attempt, and a write the brewer reverted would still count.
- **A failure before the first model reply as "could not start"**: it ends as `attempts_exhausted`, which hides that the machine is what needs fixing (ADR 0046's reason for the environment fact).
- **An `is_error` result as a crash** (the exit code rule): the exit code is not always 1 for an error, and the reason would not say what the error was.
- **The runner chooses the session id:** the engine could then record it only once the attempt started, and a resume needs it from the engine anyway.
