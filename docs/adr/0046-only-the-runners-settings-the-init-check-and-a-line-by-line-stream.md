# 0046. Only the runner's settings, the init check, and a stream read line by line

Date: 2026-10-16 · Status: Accepted · Amends [0028](0028-brewer-runner-outcomes-environment-and-test-first.md) and [0042](0042-the-claude-command-line-and-stream-contract.md) · Amended by [0047](0047-the-claude-brewer-runner-its-stream-endings-and-progress.md), [0049](0049-reviewers-read-only-inside-the-checkout.md), [0057](0057-real-claude-tests-are-opt-in-and-claude-proofs-leave-the-suite.md), [0062](0062-brewers-never-allow-git-with-no-fixed-subcommand.md), [0087](0087-sandboxed-commands-go-through-the-allow-rules-and-never-see-credentials.md) and [0117](0117-a-retry-resumes-the-session-of-the-attempt-before-it-in-that-attempt-s-worktree.md)

## Context
[ADR 0042](0042-the-claude-command-line-and-stream-contract.md) fixed the `claude` command line and the stream the brewer runner reads, and left questions to the real runner (#11). The consultant's review of the spike ([#11, comment](https://github.com/EdwinBekaert/foedrum/issues/11#issuecomment-6215999983)) marked three of them as blocking: no real brewer may run before they are settled.

1. **User settings widen a brewer.** `--safe-mode` still loads `~/.claude/settings.json`. Its `permissions.allow` widens the brewer's allowlist (a user's `Bash(*)` allows any command), and its `env` gets around the minimal environment (#81). `--setting-sources ""` was accepted by the CLI, but nobody had shown that it leaves out the user's file and keeps the login.
2. **Settings dropped silently.** `claude` drops a `--settings` file that fails its own validation, deny rules included, and nothing in the stream says so.
3. **Output volume.** Each stream line is about 2.8 KB, tool results come back in full, and a long attempt passes the 4 MiB at which the process runner kills a process ([ADR 0035](0035-the-process-runner-kills-at-an-output-limit.md)). The runner had no way to read a stream as it comes, and no stdin input for the prompt.

## Decision

### Only the runner's own settings
- The command line passes `--setting-sources ""`: `claude` loads no user, project or local settings file, only the one given with `--settings`, which the runner writes. `claudeArgs` (`src/brewers/claude-command.ts`) builds ADR 0042's command line with it, and refuses a model, tool name, session id or `maxTurns` that is not valid, so none reads as an option. That is not all that npm's `claude.cmd` needs: `windowsCommandLine` (ADR 0031) also refuses `[`, `]` and other characters, so a model id with `[1m]` or a path with `&` cannot start `claude.cmd`, and the attempt fails closed as one that could not start. The runner supports the native `claude.exe` first, and doctor is to report a `.cmd`-only install (item 8 of the consultant's list), with the runner.
- **Verified** against `claude` 2.1.301 by `test/integration/claude-cli.test.ts`. The test points `CLAUDE_CONFIG_DIR` at a throwaway folder whose `settings.json` allows `Bash(*)` and sets a variable, and `ANTHROPIC_BASE_URL` at a fake Messages API on 127.0.0.1 (`test/integration/fake-messages-api.ts`), whose "model" runs one `node -e` command through Bash. So the test needs no login, spends no tokens and sends nothing off the machine.
  - Without the flag, the command runs and prints the user's variable. This control case proves that the throwaway file is read at all.
  - With the runner's command line, the same call is a `permission_denied` (`decision_reason_type: "mode"`).
  - With an attempt rule that allows the command, it runs and the user's variable is unset.
  - By hand, on the same version: a user `deny: ["Read"]` removed `Read` from `init.tools` without the flag and not with it. A subscription login still works with the flag (one haiku call, `is_error: false`).
- The test runs wherever `claude` is on PATH and is skipped elsewhere; CI does not install `claude`, so it is run on a developer's machine, like the recapture and smoke tests of ADR 0042. Because it is verified, the consultant's fallback (the runner refuses to start brewers and doctor says why) is not needed. A CLI version that loads the user's file again fails this test. At run time, the init check below catches the part that changes the session (a tool removed, the permission mode), but not an allow rule or a variable.
- Managed (policy) settings are not one of the sources the flag names (`user`, `project`, `local`). They are the organisation's, not the user's, and Foedrum does not try to get around them; this ADR does not verify how they combine with the flag.

### The settings file from a schema
- `AttemptSettings` (`src/schemas/attempt-settings.ts`) is a strict schema of the only keys the runner writes: `permissions.allow` (allowlist entries, never `AskUserQuestion`), `permissions.deny` and, where the isolation level relies on Claude Code's sandbox, `sandbox` with `enabled: true`, `failIfUnavailable: true` and `allowUnsandboxedCommands: false`. A refinement requires the deny rules that every attempt has: `AskUserQuestion`, and `git push` in each shell it allows (`Bash(git push *)`, `PowerShell(git push *)`).
- ADR 0042's `env` key is left out: the brewer's variables go into the process environment (`buildBrewerEnv`, ADR 0028), and a key the runner does not need is one more way for the file to be dropped.
- `attemptSettings` (`src/brewers/attempt-settings.ts`) builds the settings from the brewer's rules, adds the always-denied rules once each, and validates. `writeAttemptSettings` validates again and writes the JSON, or throws and writes nothing.
- The contract test of ADR 0042 is in the same integration file: a deny rule in the file the runner wrote (`Bash(node -e *)`, next to an allowed `Bash(node *)`) takes effect.

### The init check
- `checkInit` (`src/brewers/claude-init.ts`) reads the init event with a loose zod schema (`ClaudeInit`, `src/schemas/claude-stream.ts`) and compares it with what the runner asked for. It is a mismatch when:
  - the session id is not the one the runner chose;
  - the permission mode is not `dontAsk`;
  - a tool is there that was not asked for (an `mcp__…` tool included), or one that was asked for is missing (a bare deny rule removed it);
  - there is an MCP server, a skill or a slash command;
  - a field it reads is missing or of another type: what cannot be read cannot be shown to match.

  A brewer's own `skills` and `mcp` are not supported yet; when they are, the asked session names them. What claude loaded may come from an untrusted repository, and the reason ends in a summary a human reads, so it names at most three entries of each kind, each cut to 40 characters, and how many more.
- The runner checks the init event before it reads anything else of the stream. **Other system events can come first:** with an API key, or a configuration folder `claude` has not seen, 2.1.301 sends `system/ui_invalidate` before `init`; the fixtures, captured with a subscription login, do not show it. The stream parser skips `system` events before `init`. A `result` before `init` is a start failure (ADR 0042's `--resume` of a missing session), and any other event before `init` is a mismatch.
- **A mismatch is an environment failure.** It is a new fact of [ADR 0028](0028-brewer-runner-outcomes-environment-and-test-first.md), `environment` (why the session is not what was asked), and the first row of its table:

  | Facts | Ending |
  |---|---|
  | claude did not set up the session the runner asked for | `blocked` + `environment` (Stuck at once) |
  | The process could not start | `failed`, not retryable |
  | … | (the rest of ADR 0028's table) |

  The summary is `claude did not set up the session the runner asked for: <reason>`. Another attempt would meet the same settings, so it is not retried, and unlike "could not start" it goes to the environment lane, where a human fixes the machine. This replaces ADR 0042's "stops the attempt as not startable" for a mismatched init.

### Reading the stream line by line
- `streamProcess` (`src/platform/processes.ts`, with `streamProcessWith` for tests) is the process runner for streams:
  - It hands each stdout line to the caller's `onLine` as it comes, without its line ending (LF or CRLF), and keeps none of it, so a stream has no total limit.
  - A line longer than `maxLineBytes` (bytes, not counting the line ending) kills the tree and answers with `killed: 'line-too-long'`, a `StreamKilled` beside ADR 0035's three. None of that line is handed over.
  - stderr is kept up to `maxStderrBytes` (default 4 MiB), past which the tree is killed as `too-much-output`.
  - `stdin` is written to the program and closed. A program that exits before reading it makes the write fail (EPIPE), which is ignored: how the program ended says more.
  - A deadline, an aborted signal and a program that cannot start answer as `execProcess` does. Once the runner kills or stops the process, no further line is handed over, not even the rest of the chunk that was being read. So a caller that stops the attempt from a line (a mismatched init, `maxDenials`) sees nothing after it.
  - A last line without a line ending is handed over when the process closes.
- With `jobObject: true` (ADR 0039), stdin reaches the program through the helper, which passes its own handles on; this is verified on Windows. The helper's refusal is written alone on stdout before the program exists, so a first line that looks like it is held back until the process writes more or ends. When the process ends as the refusal says, nothing is handed over and the answer is "not started", as in `execProcess`.
- `execProcess` and its 4 MiB default are unchanged. The test-layer guard (`scripts/check-test-layers.ts`, ADR 0021) reports a unit, property or chaos test that imports `streamProcess`, as it does `execProcess` and `spawnProcess`.

### The longest command line
- With a model id with `[1m]`, `xhigh`, 99,999 turns, 13 tools, a resumed session, and three paths of about 250 characters each (`claude.exe`, the settings file, a system prompt file), the program's command line is 640 characters, and 14,037 through the Job Object helper with a working directory of the same length, against Windows's 32,767. A unit test pins it at 1,500 and under the limit.

## Consequences
- The three blocking questions of ADR 0042 are settled, so the runner can be built on them. The rest of #11 (the stream parser over the fixtures, `is_error`, endings for failures before the first assistant event, the stall watchdog, prompts as `BrewerPrompt` on stdin, `jobObject: true`, the runner itself) follows in a separate pull request.
- A user whose login lives in their settings file (an `apiKeyHelper`, or `ANTHROPIC_API_KEY` in its `env`) is not logged in for a brewer. A subscription login and an API key in the engine's environment work. The runner and doctor must say so when it happens; it is not handled yet.
- The brewer runner chooses its own `maxLineBytes`. A `Read` of a large file comes back as one line, so the limit must sit well above any file a brewer reads, and below what the engine can hold.
- The fake runner and the engine tests can now play an environment mismatch through the new fact.

## Alternatives considered
- **doctor refuses a user settings file with `permissions.allow` or `env`** (ADR 0042's other route): it would make users change their own Claude Code setup for Foedrum, and it sees only the one file, not what Claude Code merges from others.
- **`--setting-sources project` or `local`:** both read the target repository's settings, which are untrusted.
- **`--bare`:** loads no settings, but it does not work with a subscription login (ADR 0042).
- **A mismatched init as a retryable failure, or as "could not start":** a retry meets the same settings and spends an attempt; "could not start" ends as `attempts_exhausted`, which hides that the machine is what needs fixing.
- **A larger total output limit instead of a limit per line:** a stream of several hundred megabytes would be held in memory twice, and it only moves the wall.
- **The settings inline on the command line:** dropped just as silently when invalid, and it costs command-line length (ADR 0042).

## Verification
- `--setting-sources ""` verified against `claude` 2.1.301 when this was decided (`test/integration/claude-cli.test.ts`).
