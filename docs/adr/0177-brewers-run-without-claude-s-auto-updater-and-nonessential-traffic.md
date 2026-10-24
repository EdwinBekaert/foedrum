# 0177. Brewers run without claude's auto-updater and nonessential traffic

Date: 2026-10-24 · Status: Accepted · Amends [0063](0063-foedrum-serve-its-configuration-and-wiring.md) (the variables the runner forces), [0109](0109-a-brewer-s-git-holds-no-push-credential.md) (its table of forced variables)

## Context
A brewer's claude starts with `--setting-sources ""` ([ADR 0046](0046-only-the-runners-settings-the-init-check-and-a-line-by-line-stream.md)), so it reads no user settings, and with them not the `env` in which a user turns claude's auto-update off.
Its environment is a minimal base, the brewer's own `env`, and the runner's forced variables last (`buildBrewerEnv`, [ADR 0063](0063-foedrum-serve-its-configuration-and-wiring.md), [ADR 0109](0109-a-brewer-s-git-holds-no-push-credential.md)); none of them stops claude's background updater.

In the fourth brew (batch `9-1`, #442) the user's own sessions ran with `DISABLE_AUTOUPDATER=1`, yet `claude.exe` updated itself from 2.1.301 to 2.1.310 at 19:46, mid-brew, and the next attempts ran on 2.1.310 (#472).
The binary is the user's own, so a brewer's update changes the claude every session on the machine runs, and the version Foedrum's stream contract was checked against ([ADR 0042](0042-the-claude-command-line-and-stream-contract.md)) with it.

Claude Code's docs ([Environment variables](https://code.claude.com/docs/en/env-vars), read 2026-10-24):
- `DISABLE_AUTOUPDATER`: "Set to `1` to disable automatic background updates."
  `FORCE_AUTOUPDATE_PLUGINS` is there to "force plugin auto-updates even when the main auto-updater is disabled via `DISABLE_AUTOUPDATER`", so plugin auto-updates stop with it too.
- `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` disables "auto-updates, telemetry, error reporting, the `/feedback` command, […] release notes, […] availability checks", stops background runs of plugin `command` sources, and "also disables feature-flag fetching".

A brewer loads no MCP server (`--strict-mcp-config` with no config) and no plugin from settings (ADR 0046), so there is nothing else of those to update or fetch.

## Decision
`brewerForcedEnv` (`src/engine/brewer-env.ts`) adds two variables to the runner's forced layer:

| Variable | Value | Why |
|---|---|---|
| `DISABLE_AUTOUPDATER` | `1` | No background update of claude, and with it none of plugins, during an attempt |
| `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` | `1` | The updater again, by a second name the docs give for it, and no telemetry, error reporting or feature-flag fetching: an attempt sends Anthropic only what the run itself needs |

The layer goes last, so neither the base nor a brewer's `env` can replace them, in any case on Windows (ADR 0028): a user's `DISABLE_AUTOUPDATER=0`, or an empty value, in the terminal `foedrum resume` takes its environment from does not win.
A brewer's `env` may already not name `CLAUDE_*`; `DISABLE_AUTOUPDATER` it may name, and the forced value replaces it.

Every place that takes the forced layer gets both: every brewer attempt, every check step ([ADR 0069](0069-check-steps-run-the-repositorys-commands-in-an-attempt-of-their-own.md)), and `foedrum resume`'s session ([ADR 0126](0126-foedrum-resume-opens-a-finished-attempt-s-session-in-its-worktree.md)).
`foedrum doctor` shows claude's version as before; there is no new check.

## Consequences
- A brew runs on the claude it started with; `claude --version` before and after a brew is the same, also when a newer claude is out.
  Updating claude is the user's own act, outside a brew.
- A brewer's claude runs without the feature flags it would fetch, on their built-in defaults.
  Foedrum reads only claude's stream and exit code; the one change the proof below shows is a `system/ui_invalidate` event before `init`, which the runner already skips (ADR 0046).
- Telemetry and error reports of brewer runs no longer reach Anthropic, so a crash of claude in an attempt is known only from Foedrum's own records.

## Verification
On claude 2.1.310 (Windows, subscription login), `claude --print` with the brewer's command line (`claudeArgs`), its minimal base and the forced layer ran twice with both variables and twice without them as a control; each run exited 0 and ended in `result/success` (#472).
The streams had the same shape, `system/init`, `assistant`, `rate_limit_event`, `result/success`, except that every run with the variables began with `system/ui_invalidate`.
Run with each variable alone, `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` sends it and `DISABLE_AUTOUPDATER` does not.
ADR 0046 already skips `system` events before `init` (it saw `ui_invalidate` with an API key), and `test/unit/claude-stream.test.ts` covers it, so the runner needs no change.

## Alternatives considered
- **`DISABLE_AUTOUPDATER` alone.** It stops the update that was seen, but leaves telemetry, error reports and feature-flag fetching, which an attempt does not need and which can change claude's behaviour between attempts of one brew.
- **Read the user's settings for their `env`.** ADR 0046 keeps the user's settings out of a brewer on purpose; one variable is not a reason to let them in.
- **Pin claude's version in doctor.** A check finds a changed version after the fact; it does not stop the change.
