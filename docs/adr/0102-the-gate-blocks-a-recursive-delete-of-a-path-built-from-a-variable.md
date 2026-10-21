# 0102. The local gate blocks a recursive delete of a path built from a variable

Date: 2026-10-21 · Status: Accepted · Amends [0045](0045-the-local-gate-reads-commands-as-the-shells-would.md) (what the gate reads) and [0056](0056-the-gate-pre-filter-reads-the-command.md) (the pre-filter's words)

## Context
CLAUDE.md says never to `rm -rf` or `Remove-Item -Recurse` a path built from a variable or a substitution (#279): an empty or wrong value removes the wrong tree. Sessions broke that rule three times on 2026-10-20 while it was written only in prompts. A rule that must never break belongs in the gate (#281). The gate already reads every Bash and PowerShell command the way the shells would ([ADR 0045](0045-the-local-gate-reads-commands-as-the-shells-would.md)), but its pre-filter ([ADR 0056](0056-the-gate-pre-filter-reads-the-command.md)) lets a command that mentions none of git, gh and the other words through unread, and `rm -rf "$dir"` mentions none of them.

## Decision
- **What is a recursive delete.** `rm` with `-r` or `-R` in a group of its short options, GNU's and BSD's (`-rf`, `-fR`, `-rfv`, `-Prf`), quoted or not, or `--recursive` or a prefix of it that GNU rm accepts (`--rec`); `Remove-Item` and its aliases (`rm`, `ri`, `del`, `erase`, `rd`, `rmdir`) with `-Recurse` or a prefix of it (`-r`, `-rec`), also after an en dash, em dash or horizontal bar, which PowerShell reads as a parameter's dash, and as `-Recurse:<value>` but not `-Recurse:$false`; and cmd's `rd`, `rmdir`, `del` and `erase` with `/s`, also among switches written together (`/s/q`). The words are read the way the gate reads git and gh: after wrappers, in compound commands, nested shells (`bash -c`, `pwsh -Command`, `cmd /c`), evaluators and substitutions, in both dialects.
- **What is a path built from a variable.** Any argument of that command that the reader marks as computed at run time (`$x`, `${x}`, `$env:X`, `$( )`, bash's backticks), PowerShell's `@( )`, a PowerShell `( )` argument of the delete (`(Join-Path $root run)`, `(Get-Location)`), or one that holds cmd's `%X%`. A PowerShell switch given a value (`-Recurse:$true`) and a redirection (`2>$null`) are no path. Such a command is blocked with one line that says to write the literal path, such as `rm -rf .foedrum/tmp/218/run`.
- **Literal paths pass.** A literal path, a glob (`.foedrum/tmp/218/*`), a single-quoted `$`, a delete without recursion (`rm -f "$file"`, `Remove-Item $p`) and a pipeline into `Remove-Item -Recurse` pass (see Consequences), as does text that only mentions such a command (`echo`, `grep`).
- **The pre-filter lets them through.** Besides its words, the pre-filter passes a command to the reader when it mentions `rm`, `rd`, `ri`, `del`, `erase` or `remove` (after the shells' quotes and escapes are dropped, as for the other words) and holds a `$`, a `%`, a backtick or a `(` (before they are dropped). A command with neither still exits before parsing.

## Consequences
- The CLAUDE.md rule holds in every session, not only where a prompt repeats it; the "Always blocked" list names it, and the "Temporary files" rule points there.
- More commands are parsed: `ri` and `rd` are parts of many words (`string`, `word`), so any command that has one of them and a `$` or `%` costs a parse, a few milliseconds, but no process.
- A delete whose path is a variable for a good reason must name the path as it is. A heredoc or inline multi-line string that quotes such a command is read as commands (ADR 0045) and blocked too.
- As with pushes, arguments computed at run time are not evaluated: a path from `xargs`' input or `find -exec rm -rf {}` passes, and so does a delete program whose name is itself computed, and a pipeline into `Remove-Item -Recurse` whose earlier stage reads a variable (`Get-ChildItem $dir | Remove-Item -Recurse`): the gate reads each command of a pipeline on its own. The value of another option (`-ErrorAction $pref`, `-Filter $f`) counts as computed, so such a delete is blocked even when its path is literal: the gate fails closed there. The gate catches a session's mistakes, not intent.

## Alternatives considered
- **Leave the rule in CLAUDE.md:** it was broken three times in a day.
- **Deny rules in `.claude/settings.json`:** a rule matches the start of a command only, so `cd x && rm -rf "$d"` or `bash -c` slips past, and rules cannot tell a quoted `'$d'` from `"$d"`.
- **Block every recursive delete:** cleanup of `.foedrum/tmp/<issue>/` is routine and its literal paths are safe.
- **Add `rm` and `ri` to the pre-filter's words without the `$`/`%`/backtick/`(` test:** parses nearly every command, for no gain, since a command without them has no computed path.
