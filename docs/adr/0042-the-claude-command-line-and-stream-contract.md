# 0042. The `claude` command line and the stream the brewer runner reads

Date: 2026-10-16 · Status: Accepted, amended by [0106](0106-the-nopush-guard-compares-the-remote-s-refs-around-each-attempt.md) (what `noPush` compares, and how it ends the attempt) · Amends [0003](0003-drive-the-claude-cli.md), [0019](0019-interactive-sessions-and-one-command-layer.md) and [0028](0028-brewer-runner-outcomes-environment-and-test-first.md) · Amended by [0046](0046-only-the-runners-settings-the-init-check-and-a-line-by-line-stream.md), [0047](0047-the-claude-brewer-runner-its-stream-endings-and-progress.md), [0062](0062-brewers-never-allow-git-with-no-fixed-subcommand.md) and [0087](0087-sandboxed-commands-go-through-the-allow-rules-and-never-see-credentials.md)

## Context
[ADR 0003](0003-drive-the-claude-cli.md) runs brewers through the user's `claude` CLI with `--output-format stream-json`, and [brewers-and-recipes.md §4](../brewers-and-recipes.md#4-how-a-brewer-runs) sketches the command line. Both were written from memory. Before the real brewer runner (#11, ADR 0028) is built, #17 checks them against the installed CLI: the flags, the stream events and fields the runner reads, exit codes, how the prompt goes in, sandbox settings, and spawning on Windows.

The spike ran `claude` 2.1.301 (the native `claude.exe`, Windows 11, logged in with a subscription): 12 calls that fail before any request and 18 small model calls, all but one with haiku at low effort, for a few cents at the CLI's list-price estimate. The fixtures in `test/fixtures/claude-stream/` were captured last, on 2026-10-16, with the exact command line below; `manifest.json` gives each case's arguments, stdin, exit code, stderr, whether it has `init`, and its result subtype. They are scrubbed: paths are synthetic, `rate_limit_info` keeps only its status, thinking signatures are replaced, and the session, event, tool-use, message and request ids are synthetic, mapped consistently. The docs consulted are the CLI reference, headless mode, the Agent SDK's TypeScript message types and the sandbox page on code.claude.com. `claude --help` does not list every flag, as the CLI reference says: `--max-turns` and `--system-prompt-file` work but are missing from it.

## Decision

### The command line
A fresh attempt runs:

```
claude --print --verbose --output-format stream-json
       --permission-mode dontAsk --permission-prompts none
       --model <model id> --effort <level> --max-turns <maxTurns>
       --settings <attempt settings file>
       --tools <built-in tool names> --disable-slash-commands --strict-mcp-config
       --safe-mode
       --session-id <uuid>              # or --resume <session id>
       [--append-system-prompt-file <file>]
```

The prompt goes in on stdin, with no prompt argument (not even `-`).

| Flag | Verified behaviour | Why the runner passes it |
|---|---|---|
| `--verbose` | `stream-json` with `--print` and without it: exit 1, `Error: When using --print, --output-format=stream-json requires --verbose` | Required |
| `--permission-mode dontAsk` | A tool call outside the allow rules is denied (`system/permission_denied`, `decision_reason_type: "mode"`), the run goes on | The allowlist decides, nothing waits for an approver (§1.1) |
| `--permission-prompts none` | Accepted (`host` or `none`); the docs say it tells Claude not to retry a denied request and removes the tools that need a person, such as `AskUserQuestion` | ADR 0006; fewer retried denials in a storm |
| `--model` | An unknown id is not refused when parsed: the run starts, the assistant message has `error: "model_not_found"`, exit 1 | The id comes from `models.jsonc`; doctor checks it |
| `--effort` | An unknown value only warns on stderr and runs at the default effort, exit 0 | The brewer schema validates it (`low` … `max`); the runner never passes an unchecked value |
| `--max-turns` | Missing from `--help`, works: `result/error_max_turns`, `terminal_reason: "max_turns"`, exit 1; a non-number is refused when parsed | `claude` enforces the brewer's `maxTurns` itself |
| `--settings <file>` | A file that fails validation is **dropped silently**: with `"model": 123` next to `"permissions": {"deny": ["Read"]}`, the Read ran | Always a file the runner writes, never inline JSON; see below |
| `--tools` | `init.tools` is exactly the list (`Read,Grep,Glob,Bash` gave those four); without it a session has 27 tools, among them `RemoteTrigger`, `PushNotification`, `CronCreate`, `SendMessage`, `Task`, `Skill` and `WebSearch` | Only the tools named in `tools.allow` exist |
| `--disable-slash-commands` | `init.skills` and `init.slash_commands` are empty | `skills` defaults to none (§1.1); left out when the brewer names skills |
| `--strict-mcp-config` | `init.mcp_servers` is empty with it; the docs say only `--mcp-config` servers load | Always passed: a brewer's own servers (`mcp`) go in through `--mcp-config`, so no server from the user or the repository loads |
| `--safe-mode` | Without it, a run in a scratch git repository nested in Foedrum's checkout loaded Foedrum's `CLAUDE.md` from a parent folder | Hooks, `.mcp.json` servers, `CLAUDE.md`, skills and plugins of the target repository do not load; the docs say `-p` otherwise runs a project's hooks even in a folder never trusted |
| `--session-id <uuid>` | `init.session_id` is the given id; a value that is not a UUID: exit 1 before any request | The runner chooses the session id |
| `--resume <id>` | The same session id and conversation; an id with no transcript: exit 1, a lone `result/error_during_execution` with no `init` | `answer` and `retryMode: resume` (ADR 0019) |
| `--system-prompt-file`, `--append-system-prompt-file` | Missing from `--help`, exist: a missing file gives exit 1 before any request | [ADR 0041](0041-untrusted-input-in-per-prompt-nonce-tags.md) builds the whole prompt (instructions, the rule, the inputs) in `assembleBrewerPrompt`, and it goes on stdin. If the runner moves the instructions into a system prompt, the rule goes with them (ADR 0041), through a file, so neither flag costs command-line length |
| prompt on stdin | `-p` without a prompt argument reads stdin; so does `-p -` | Prompts never go on the command line (ADR 0039's budget, cmd.exe quoting); the docs cap piped stdin at 10 MB |

- **Not `--bare`.** It skips OAuth and the keychain, so it does not work with a subscription login (ADR 0003). `--safe-mode` keeps authentication and is the brewer's lean context.
- **Not `--no-session-persistence`** for brewer attempts: sessions are kept for the batch (ADR 0019). Only doctor's probes, which nobody resumes, may pass it.
- **Not `--max-budget-usd`.** It checks a client-side cost estimate; Foedrum's budgets are `maxTurns` and `deadline`.

### The settings file
- The runner writes the per-attempt settings from a strict zod schema of the keys it uses (`permissions.allow`, `permissions.deny`, `sandbox`, `env`), so a file the CLI would drop cannot be produced. A contract test against the real CLI checks that a deny rule in it takes effect.
- Its deny list always names `AskUserQuestion`, and `git push` for every shell tool the brewer has (`Bash(git push *)`, `PowerShell(git push *)`) (§1.1). A scoped rule matches the command as written, so `git -C . push` slips past it: the deny rule only cuts down on attempts. The engine's `noPush` guard (§1.1), which fails the attempt when the branch moved on the remote, is the check that holds. (Since [0106](0106-the-nopush-guard-compares-the-remote-s-refs-around-each-attempt.md) it compares every ref of the remote and makes the batch Stuck on a divergence.)
- A bare tool name in `deny` (`"Bash"`) removes the tool: a call to it is an `is_error` tool result, `No such tool available: Bash`, and no permission denial. A scoped rule (`Bash(git push *)`) leaves the tool and denies the matching calls (`decision_reason_type: "subcommandResults"`). Denying `Bash` also removed `PowerShell` on Windows.
- In a workspace the user never trusted, a repository's `.claude/settings.json` `permissions.allow` entries are ignored with a warning on stderr; attempt worktrees are new paths, so they are untrusted.

### The stream the runner reads
Every stdout line is one JSON object with a `type`. A line that is not is the garbage fact of ADR 0028. The runner reads these and ignores every other type, including types it does not know:

| Event | Fields read | Use |
|---|---|---|
| `system/init` | `session_id`, `model` (the full id), `permissionMode`, `tools`, `mcp_servers`, `claude_code_version` | The first line when there is one (hook events could come before it; `--safe-mode` runs no hooks). The runner records the session and the CLI version (ADR 0019) and stops the attempt as not startable when `permissionMode` is not `dontAsk`, or a built-in tool in `tools` is not in `--tools` (an MCP server's `mcp__<server>__*` tools are checked against the brewer's `mcp` instead). These are new cases of ADR 0028's "could not start" fact: not retryable |
| `assistant` | `message.content[]`: `text`, `thinking`, `tool_use` (`id`, `name`, `input`); `error`; `parent_tool_use_id` | Progress; `parent_tool_use_id` is not `null` for a subagent's messages |
| `user` | `message.content[]`: `tool_result` (`tool_use_id`, `is_error`, `content`) | Progress |
| `system/permission_denied` | `tool_name`, `tool_use_id`, `decision_reason_type` | One denial each (`noteDenial`); live, so the runner can stop at `maxDenials` |
| `result` | `subtype`, `is_error`, `num_turns`, `terminal_reason`, `errors`, `usage`, `permission_denials`, `session_id` | The last line; how the run ended |

- **`is_error` decides, not `subtype`.** `subtype` is `success`, `error_max_turns`, `error_during_execution`, `error_max_budget_usd` or `error_max_structured_output_retries`, but an API error (the unknown model) ends as `subtype: "success"` with `is_error: true` and `terminal_reason: "api_error"`.
- **Exit codes:** in every capture, exit 0 came with `is_error: false` and exit 1 with `is_error: true`. Arguments refused when parsed exit 1 with the reason on stderr and nothing on stdout. A `SIGTERM` exits 143 (docs). The fixture test pins the exit-code rule on every capture.
- **Turns:** the runner reports `result.num_turns` as its turns fact, and `terminal_reason: "max_turns"` as a budget exceeded. `num_turns` counts the model turns, including the one about to start, so `--max-turns 1` ended with `num_turns: 2`. In every capture it was one more than the number of tool results, because each turn made at most one tool call; a turn with parallel calls has more results than turns, so the runner reads `num_turns` and never derives it. Then ADR 0028's `turns > maxTurns` holds exactly when `claude` stopped at the limit. Counting assistant messages does not work: one turn can stream several (`thinking`, `text` and each `tool_use` separately).
- **Usage:** `result.usage` has `input_tokens`, `output_tokens`, `cache_read_input_tokens` and `cache_creation_input_tokens`, which map to `Usage` (`inputTokens`, `outputTokens`, `cacheReadTokens`, `cacheWriteTokens`). These figures and `total_cost_usd` are reported on a subscription too (`apiKeySource: "none"`); the cost is a client-side estimate. On `--resume`, `usage` covers only that run (the capture), while `total_cost_usd` includes the session's earlier runs (the docs, and the capture: 0.0012 then 0.0020). The runner records `usage` and never sums the cost across attempts.
- **`rate_limit_event`** carries the account's usage of its rate-limit windows. The runner never records it.

### Spawning on Windows
- The native installer puts `claude.exe` on `PATH`, a console program that node starts directly, without a shell; the spike's harness did so. Only npm's global install gives `claude.cmd`, which the runner starts through cmd.exe (ADR 0031). This corrects ADR 0003's "on Windows the CLI can only be spawned through a shell".
- The longest command line above is about 1,300 characters with a working directory and two file paths of 260 characters each, against the about 6,100 that ADR 0039's Job Object helper leaves the program. The runner's tests pin its longest command line.

### Sessions
- The runner creates the session id (a random UUID) and passes it with `--session-id`, so the attempt's session is recorded before the process starts, not learned from the first stream event. This amends ADR 0019, which took it from the stream, and ADR 0028's consequence that the runner learns it from the stream; `init.session_id` must equal it, or the attempt stops as not startable (ADR 0028's "could not start").
- `--resume` also accepts the absolute path of a session's `.jsonl` transcript (docs), which is the route for resuming on another machine that ADR 0019 left to a spike.

### The sandbox
- Wherever the isolation level relies on Claude Code's sandbox (macOS, Linux, WSL2; ADR 0010), the settings set `sandbox.enabled`, `failIfUnavailable: true` and `allowUnsandboxedCommands: false`. By default, a sandbox that cannot start runs commands unsandboxed without failing (docs).
- On native Windows those settings end the run before any request: exit 1, `result/error_during_execution`, `Sandbox required but unavailable: … the Windows sandbox is not active on this session (feature gate off)`. The runner never sets them there; native Windows stays permissions-only (ADR 0010).

## Consequences
- `docs/brewers-and-recipes.md` §4 shows this command line, and `docs/architecture.md` §13 how `claude` is spawned. The fixtures are the brewer runner's parser tests: it must read each into the facts of ADR 0028.
- A CLI that changes the stream breaks the nightly smoke test (architecture §13). A recapture goes through the fixture test, which checks the exit-code rule, one `result` last, `init` first and one session id per stream.
- Questions this spike leaves to the real runner (#11):
  - **Output volume.** Every tool result comes back in full in the stream, and each tool input twice (`input` and `wire_tool_inputs`): a one-word reply already streams 2.8 KB lines. A long attempt passes ADR 0035's 4 MiB total, so the runner needs a line-by-line reader with a limit per line, not the total cap. `execProcess` has no stdin input and no per-line callback yet.
  - **`claude.cmd` in a Job Object.** ADR 0039's helper starts a program by its path; whether it holds `cmd.exe` running npm's `claude.cmd` the same way is not verified.
  - **`context: repo`.** Without `--safe-mode`, the target repository's hooks and MCP servers run. Giving a brewer the repository's instructions without its hooks (`--setting-sources`, or `--safe-mode` with the instructions passed in by Foedrum) needs a decision.
  - **The user's own settings: a precondition for the real runner.** `--safe-mode` still loads `~/.claude/settings.json`, whose `env` and `permissions.allow` would bypass the minimal environment (#81) and widen the allowlist (a user's `Bash(*)` would allow any command). `--setting-sources ""` is accepted; that it leaves out user settings and keeps authentication is not verified, because this machine's user settings have no rules to test with and they were not changed. The runner must not start a brewer until this is closed: verified and passed, or doctor refusing a user settings file with `permissions.allow` or `env`.
  - **A settings file dropped at run time.** Nothing in the stream shows that `--settings` was dropped; the schema prevents an invalid file, and the contract test covers the CLI's side.
  - **Endings for a bad model or argument.** Under ADR 0028, an unknown model or a refused argument reads as a crash and is retried, which spends an attempt on the same error. doctor can catch it first; a new fact may be needed.
  - **Progress for the stall watchdog.** Which events count as progress (`system/thinking_tokens`, `system/api_retry`) is not decided.
  - **A recapture test.** The fixtures were captured by hand. An opt-in integration test that reruns the manifest's cases against the installed `claude` and compares the event types and fields above with the fixtures belongs with the runner, next to the nightly smoke test.
  - **The sandbox on macOS, Linux and WSL2** was not run: this machine has no WSL2 distribution with `claude` in it. Its settings come from the docs.

## Alternatives considered
- **Inline `--settings` JSON:** no file to write, but it costs command-line length, goes through cmd.exe quoting for `claude.cmd`, and is dropped silently as well when invalid.
- **Removing tools with bare deny rules instead of `--tools`:** keeps one place for tool rules, but a tool a later CLI adds would be available by default; `--tools` allows only what it names.
- **Learning the session id from `init`:** what ADR 0019 said; a process that dies before its first line would then leave a session nobody recorded.
- **`--bare` for the lean context:** faster to start and recommended for scripts, but it never reads a subscription's OAuth login.
- **`subtype` as the result's verdict:** simpler, but an API error reports `success`.
