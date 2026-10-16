# 0043. The local gate reads commands as the shells would, and assumes the worst of what it cannot read

Date: 2026-10-16 · Status: Accepted

## Context
The local gate (`scripts/precheck.ts`, a PreToolUse hook on the Bash and PowerShell tools) blocks force pushes, deleting and mirroring pushes and `gh pr merge`, blocks a push from a detached HEAD, and runs `npm run check` before `git push` and `gh pr create`. Until now it split the command on separators, ignored quotes and took the first word as the program.

The independent review of #30 listed what that misses: wrapper words (`env git push -f`, `xargs`, `Start-Process`), other shells and evaluators (`bash -c "git push -f"`, `pwsh -c`, `cmd /c`, `iex`), git aliases (`git config alias.p push && git p -f`), command substitutions and variables (`$g="git"; & $g push`), and a quoted program path with a space. It also split strings, so `git commit -m "fix; git push -f later"` was blocked as a force push, and a `grep` pattern that contained `git push -u origin` ran the whole check (#42).

The gate guards against accidents by an agent that follows `CLAUDE.md`, not against an adversary: a shell command can always compute what it runs. So the question is how far to read, and what to do with what cannot be read.

## Decision
- **Read like the shell.** The command is split into words and simple commands with each shell's quoting: bash's `'…'`, `"…"` with `\` escapes, `$'…'` and `` `…` ``; PowerShell's `'…'` with doubled quotes, `"…"` with backtick escapes, and `@( )`. A separator inside a string starts no command. The tool names the shell, so a Bash command is read as bash and a PowerShell command as PowerShell; anything a command runs in turn, and a command from another tool, is read both ways, and blocked when either reading pushes or merges.
- **Follow what runs.** Environment assignments and wrapper words (`command`, `builtin`, `exec`, `env`, `time`, `nice`, `nohup`, `timeout`, `xargs`, `npx`, `sudo`) are skipped, with the options that take a value, before the program is named. These are read as commands too: `$( )`, `@( )` and `` ` ` `` substitutions; the operands of `sh`, `bash`, `zsh` and the like; `pwsh` and `powershell` `-Command` (and its prefixes), a decoded `-EncodedCommand`, and their operands; `cmd /c` and `/k` without `^` escapes; `eval`, `iex`, `Invoke-Expression` and `[scriptblock]::Create`; `Start-Process` from its `-FilePath` and `-ArgumentList` or their positions; `env -S` and `npx -c`. When a command runs text, every string and argument list in the command line is read as a command as well, which covers `$c = "git push -f"; iex $c` and `echo git push -f | sh`.
- **Assume the worst of a name computed at run time.** A program that is a variable or substitution may be git or gh. A git subcommand computed at run time may be push, so it runs the check. A `gh pr` action computed at run time may be a merge, so it is blocked.
- **Block alias definitions that hide a push.** `git config alias.*`, `git -c alias.*=` and `gh alias set` are blocked when the command the alias would run pushes, merges or opens a pull request. Using the alias later cannot be recognised without reading the configuration on every call.
- **Fail closed on what is too deep.** Nesting deeper than 8, or more than 2,000 reads in one command, blocks. A quote or substitution that never closes, which neither shell would run as written, is also read with its quotes removed.
- **Mention, then parse.** Input that names neither git nor gh still exits before parsing unless it mentions `push`, `merge`, `pwsh` or `powershell`, so a non-git call stays under 150 ms (#41).

## Consequences
- Every bypass in the #30 review is blocked, with a unit test each; so are their look-alikes in other forms (`powershell -enc`, `[scriptblock]::Create`, `gh alias set`).
- Text in strings no longer starts commands, so commit messages and `grep` patterns that mention a push stop being blocked or gated.
- Arguments computed at run time are not evaluated: `f=-f; git push $f`, or `xargs` adding `-f` from its input, still gets through as a gated push, and a git alias defined before the session is not known. Configuration that changes what a plain `git push` does (`remote.*.mirror`, a `+` refspec in `remote.*.push`) is not read either. These need intent, not an accident.
- Some harmless commands are gated or blocked: `$x push` runs the check, and a string literal that starts with a forbidden command, in a command line that also runs text, is read as one. The cost is a check run or a rephrased command.
- precheck.ts is larger, but it still has no static imports; parsing a 50 KB heredoc takes about 10 ms.

## Alternatives considered
- **Keep splitting without quotes:** cheap, but it blocks commit messages and misses everything behind a wrapper or another shell.
- **Run a real parser** (bash's own `-n`, PowerShell's `[Parser]::ParseInput`): starts a process on every call, which is what #41 removed, and still cannot see what a variable holds.
- **Evaluate variables and substitutions:** means running them, which is what the gate must not do before deciding.
- **Read git's configuration for aliases on every git call:** a process per call, for a case blocking the definition already covers in a session.
- **Block every command that runs text** (`bash -c`, `iex`): simple and safe, but scripts and tests use `bash -c` and `pwsh -Command` for ordinary work.
