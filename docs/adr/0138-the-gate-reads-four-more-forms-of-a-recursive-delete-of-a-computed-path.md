# 0138. The gate reads four more forms of a recursive delete of a computed path

Date: 2026-10-22 · Status: Accepted · Amends [0102](0102-the-gate-blocks-a-recursive-delete-of-a-path-built-from-a-variable.md) (what is a recursive delete of a computed path, and what passes) and [0056](0056-the-gate-pre-filter-reads-the-command.md) (the pre-filter's characters)

## Context
ADR 0102 blocks a recursive delete whose path is built from a variable or a substitution, and lists forms the gate does not read: cmd's name and switch written together (`rd/s/q %X%`, read as a program named `q`), a PowerShell splat (`Remove-Item @o`), a `( )` argument after an assignment or the dot operator (`$null = Remove-Item -Recurse (Get-Location)`), and a pipeline whose earlier stage reads a variable (`Get-ChildItem $d | Remove-Item -Recurse`). Each is a way the shells run the delete, and one a session could write by accident (#296). Reading them is reading commands as the shells would ([ADR 0045](0045-the-local-gate-reads-commands-as-the-shells-would.md)); only the splat needs a decision, since the gate cannot read the table.

## Decision
- **cmd's glued switches.** A word `rd`, `rmdir`, `del` or `erase` followed directly by switches (`rd/s/q`, `del/f/s`), as cmd reads it, is that program with the switches as its first argument.
- **Any splat into a delete is blocked.** An unquoted `@name` argument of `rm`, `Remove-Item` or one of its aliases blocks the command, with or without `-Recurse` beside it: the table may carry `Recurse` and the path, and the gate cannot read it. Bash's `rm @o`, a file named `@o`, fails closed the same way. The pre-filter ([ADR 0056](0056-the-gate-pre-filter-reads-the-command.md), ADR 0102) passes a command with a delete word to the reader when it holds an `@` too, since a splat holds none of `$`, `%`, a backtick and `(`.
- **After an assignment.** A `( )` argument counts after the words the gate skips before a program (`$x =`, the dot operator), as it does at the start of the command.
- **A PowerShell pipeline.** The words of the earlier stages of a PowerShell pipeline count as the input of a recursive delete in it, with the same test as its arguments: `$p | Remove-Item -Recurse` and `Get-ChildItem $d | Remove-Item -Recurse` are blocked, `Get-ChildItem .foedrum/tmp/218 | Remove-Item -Recurse` passes. A pipeline ends at `;`, `&&`, `||`, an `if`'s braces and a line break, unless the line ends with its pipe or the next line starts with one (PowerShell 7); a group's brackets, the call operator `&` and a stage's script block (`| Where-Object { … } |`) stay in it, so `$d | ForEach-Object { Remove-Item -Recurse .foedrum/tmp/x }` fails closed. Bash's pipelines are not read this way: rm reads no paths from its input, and `xargs`' input stays unevaluated (ADR 0102).

## Consequences
- The forms ADR 0102 listed as passing are blocked with its one line. Its other limits stay: arguments computed at run time are not evaluated, `find -exec rm -rf {}` and a delete program whose name is computed pass.
- A command with a delete word and an `@` (an e-mail address beside `rm`, say) costs a parse, as one with a `(` already does (ADR 0102).
- A splat into a delete that would be safe (`Remove-Item @o` with a literal path and no `Recurse`) must be written out.
- An earlier stage that reads a variable for another reason (`Get-ChildItem .foedrum/tmp/x -Filter $f | Remove-Item -Recurse`) fails closed, as the value of another option already does (ADR 0102).

## Alternatives considered
- **Block a splat only beside `-Recurse`:** the table itself can carry `Recurse`, which is the case the rule exists for.
- **Read bash pipelines into `xargs rm -r` too:** what `xargs` reads is not a command's argument, and ADR 0102 keeps it unevaluated; it would widen the rule past the forms found.
