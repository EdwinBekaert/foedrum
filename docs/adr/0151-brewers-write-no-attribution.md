# 0151. Brewers write no attribution

Date: 2026-10-23 · Status: Accepted · Amends [0046](0046-only-the-runners-settings-the-init-check-and-a-line-by-line-stream.md) (the runner's settings file also hides Claude Code's attribution)

## Context
A brewer runs `claude` with `--setting-sources ""` and the runner's own `--settings` file ([ADR 0046](0046-only-the-runners-settings-the-init-check-and-a-line-by-line-stream.md)), so no user or project setting reaches it. Claude Code's default attribution then applies: a commit it makes gets a `Co-Authored-By: Claude <model> <noreply@anthropic.com>` trailer, and a pull request description a generated-with line ([settings reference, `attribution`](https://code.claude.com/docs/en/settings-reference)). A brewer's commits land in a target repository, whose history belongs to the team that owns it, and Foedrum stays neutral about the tools behind it (#401). Foedrum's own repository turned the same attribution off for its sessions in #400.

Measured on 2026-10-23 with `claude -p` (Claude Code 2.1.301) committing in a scratch repository with only project settings: with `{}` the commit message ended with `Co-Authored-By: Claude Haiku 5.5 <noreply@anthropic.com>`; with `"attribution": { "commit": "", "pr": "", "sessionUrl": false }` it did not.

## Decision
- **`attemptSettings` always writes `"attribution": { "commit": "", "pr": "", "sessionUrl": false }`** (`src/brewers/attempt-settings.ts`), on every isolation level, and its schema accepts the key. A brewer's commits carry no trailer, and a pull request a brewer wrote would carry no line; Foedrum writes its pull requests itself (ADR 0071), so the `pr` part is for completeness.
- **Not `"attribution": false`.** The reference documents `false` from Claude Code v2.1.281, and says an earlier version rejects it and skips the whole settings file that holds it. For the runner's file that would drop the brewer's deny rules silently, the case ADR 0046 already guards against. The object with empty strings is read by every version that knows the key.
- No Brewery setting turns it back on: nobody has asked for one.

## Consequences
- Brewers' commits in a target repository say only what the brewer wrote.
- A test on `attemptSettings` expects the key on every isolation level.
- The commits a brewer made before this change keep their trailer: history is not rewritten.

## Alternatives considered
- **Leave Claude Code's default.** Every commit in a target repository would advertise the tool, which the repository's owner did not choose.
- **A Brewery switch, default off.** Configuration nobody needs yet; a later need adds it with its reason.
