# 0056. The local gate's pre-filter reads the command, not the whole hook input

Date: 2026-10-17 · Status: Accepted, amended by [0060](0060-the-gate-refuses-gh-pr-ready-without-the-review-summary.md), [0065](0065-the-gate-refuses-npx-of-packages-not-in-the-lockfile.md) and [0102](0102-the-gate-blocks-a-recursive-delete-of-a-path-built-from-a-variable.md) · Amends [0045](0045-the-local-gate-reads-commands-as-the-shells-would.md) (what the pre-filter matches)

## Context
[ADR 0045](0045-the-local-gate-reads-commands-as-the-shells-would.md) has the gate exit before parsing when the hook input mentions none of `git`, `gh`, `push`, `merge`, `pwsh` and `powershell`, and has the pre-filter match the raw hook input. That input holds more than the command: the `cwd`, the `transcript_path`, the tool's name and the tool call's `description`. So a checkout under `~/git/` or `~/github/`, a worktree named `…-github-…`, a description such as "Show git status", and every PowerShell call (its input names the tool `PowerShell`) send the call to the parser, whatever the command is. The parser costs time on every such call, and in a checkout whose path contains `git` the unit tests that build their hook input with the real checkout path failed (#152, #132).

## Decision
- **The command decides.** After the hook input is parsed, the pre-filter matches the normalised `tool_input.command` only: typographic quotes folded and the characters the shells drop removed, as before. A command that mentions none of the words passes without being parsed.
- **The raw-input test stays as a fast path.** It runs first, so input that mentions none of the words anywhere still passes without even being parsed as JSON. It can only let through input whose command could not match either, and input that cannot be parsed keeps its behaviour: it passes when it mentions none of the words, and blocks otherwise.
- **The words do not change.** `push`, `merge`, `pwsh`, `powershell` and `\u` still send a command to the parser, so a program computed at run time before a literal `push` or `pr merge` still counts as the worst case. A command that computes both the program and the subcommand without naming any of the words (`$(printf g)it $(printf pu)sh`, `& ('g'+'it') ('pu'+'sh')`) passes without being parsed, as a Bash command already did in a checkout whose path and input named none of them.

## Consequences
- Where the checkout is, what the transcript is called, the tool's name and the description no longer decide whether a call is parsed. The precheck unit tests pass in a checkout whose path contains `git`.
- A PowerShell call whose command mentions none of the words passes without being parsed, like a Bash call. ADR 0045's consequence that every PowerShell call is parsed no longer holds, so a PowerShell command that computes both git and its subcommand now gets through unchecked, as the Bash one did. The gate guards against mistakes by sessions, not against a determined adversary (ADR 0045), and such a command needs intent; GitHub's ruleset on `main` stays the line that holds.
- A command that the parser would block as too deep, but that mentions none of the words, passes wherever the checkout is, as it already did in a checkout whose path and input mentioned none of them.

## Alternatives considered
- **Give the tests a neutral `cwd` only:** fixes the tests, but leaves every call from such a checkout, and every PowerShell call, paying for the parser.
- **Drop the raw-input test:** the decision would be the same for every parseable input, but input that cannot be parsed and mentions none of the words would start to block, a change #152 does not ask for.
