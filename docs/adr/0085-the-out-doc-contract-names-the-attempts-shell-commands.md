# 0085. The out doc contract names the attempt's shell commands

Date: 2026-10-18 · Status: Accepted · Amends [0074](0074-git-commit-grants-fixed-git-rules-and-done-needs-a-commit.md) (what the contract of a brewer that is not committing holds, and how long it may be)

## Context
A brewer's attempt allows only the shell commands of its rules: its own `tools.allow`, the git rules `git.commit: true` grants (ADR 0074) and the repository's toolchain rules (ADR 0023). The contract told a committing brewer to commit with `git add` and `git commit`, but no brewer was told which commands its shell runs. In the live demo on 2026-10-18 (batch 3-1, haiku, two attempts in a row), the brewer first ran a heredoc and `node -e`, which was rightly denied. Claude Code's denial reads "Permission to use Bash has been denied", and the brewer took it to mean all of Bash: it made its change with Edit, never tried `git add`, and wrote `blocked` (environment). The batch went Stuck. With one line naming the commands in the brewer's own body, the next attempt committed (#222).

ADR 0005 keeps the contract around 300 tokens. A unit test holds it to 1,200 characters, and ADR 0074 to 1,400 with the lines about committing, stating that the contract of every other brewer stays within 1,200.

## Decision
- **Every brewer with Bash rules is told its commands.** Before the paragraph about asking, the contract has one line, `Your shell runs only: <commands>. A denial stops that command only.`, followed by a blank line. The commands are those of the plan's own `Bash` rules (`shellCommandsOf`, `src/brewers/attempt-plan.ts`), in the plan's order: the brewer's, then git.commit's, then the repository's, once each, each without its trailing star (`*` or `:*`), so rules that differ only in their star name one command. A committing brewer reads `git status, git add, git commit` and any others it has. The line is computed from the same rules the attempt settings allow, so it cannot drift from them.
- **PowerShell rules are left out.** The runner's sessions have no PowerShell tool (ADR 0074), so a PowerShell command named as one the shell runs could never run, and a brewer that tried it through Bash would be denied: the misreading this line is meant to prevent.
- **No line when the plan has no Bash rules, or when one of them allows any program** (`Bash`, `Bash(*)`, or a command that starts with a star, such as `Bash(**)` or `Bash(*foo)`): "only" would be false. Such a rule never reaches a running attempt, since the attempt settings refuse it (ADR 0082), but a repository's tools may hold one when the plan is made.
- **The length limits hold the fixed text.** The contract with the commit lines and the three git commands is 1,395 characters, within ADR 0074's 1,400. The list itself grows with the brewer's and the repository's rules, which Foedrum does not control, so a brewer with shell rules may pass 1,200 characters, or 1,400 when it commits. The tests measure the contract without the repository's rules.
- **Tests, unit only** (`test/unit/attempt-plan.test.ts`): the committing brewer's line, a brewer's own `Bash` rules with the repository's, each command once, PowerShell rules left out, no line without Bash rules or with one that allows any program, and the length with the commit lines. Brewer prompts are exempt from red proof but not from verification: the opt-in real-claude tests ran once with the new prompt.

## Consequences
- A brewer whose command is denied knows its other commands still run, and which ones.
- ADR 0074's "the contract of every other brewer is unchanged and stays within its 1,200 characters" no longer holds for a brewer with shell rules: its contract gains the line.
- Every prompt with shell rules is a few tokens longer, about 15 for a committing brewer, plus one entry per rule.

## Alternatives considered
- **Name PowerShell rules' commands too, labelled as such (review of #231):** the runner does not turn the PowerShell tool on, so they would name commands the brewer cannot run.
- **Name only git.commit's commands:** a brewer with other rules, such as `npm test`, would misread a denial the same way.
- **Say only that a denial stops that command, without the list:** the brewer would keep guessing commands until `maxDenials` blocks it; the list tells it what works on the first try.
- **Raise the 1,400 limit for the longer sentence the issue suggested ("A denied command denies that command only."):** it was 4 characters over; the shorter sentence says the same within ADR 0005's budget.
