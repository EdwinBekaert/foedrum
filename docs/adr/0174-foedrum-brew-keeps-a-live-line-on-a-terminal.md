# 0174. `foedrum brew` keeps a live line on a terminal

Date: 2026-10-24 · Status: Accepted · Amends [0123](0123-foedrum-brew-drives-one-batch-under-an-owner-of-its-own.md) (what `brew` prints when its standard output is a terminal), [0047](0047-the-claude-brewer-runner-its-stream-endings-and-progress.md) (the runner's progress of a running attempt also says what it did last, for display) and [0172](0172-an-attempt-s-receipt-from-its-stream.md) (a shell command's prefix has one reader, for the receipt and the live line)

## Context
`foedrum brew` prints a line when the batch's lane or step changes and, while a step runs, `batch <id> brewing: <step> #<n> running for <time>` every 30 s (`PROGRESS_MS`, #406). Its loop ticks every 5 s (`INTERVAL_MS`). In a terminal the screen stands still for those 30 s, so a brew looks stuck while the brewer works (the third brew, Brewery issue #8).

Tools that run for minutes keep one line alive instead: a spinner and a counter rewritten in place (npm, pnpm), or what the worker does now (`gh run watch`), and only when standard output is a terminal. Everything such a line could say about a claude brewer is already in the stream the runner reads (ADR 0047): the turns, each tool call with its input, and each denial. The tool's input is text a model wrote from an untrusted order, and a terminal acts on control sequences, so what of it is shown is a security choice, not a layout one. The details were settled with the maintainer on #442 (2026-10-24).

## Decision
- **When:** `brew` draws the live line only when `process.stdout.isTTY` is true, `TERM` is not `dumb`, and `CI` is not set. Otherwise it prints what it prints today, every 30 s, byte for byte: a pipe, a log, the plugin in a Claude Code session (ADR 0125) and CI read no control characters. The line uses no colour, so `NO_COLOR` changes nothing.
- **What one running attempt shows**, in this order, joined by ` / `:
  - the step and attempt (`implement #1`);
  - its elapsed time, as the plain lines write it;
  - for a brewer attempt, its turn (`turn 14`), counted as ADR 0047 counts turns;
  - what it did last: the tool's name, and one safe word for some tools:
    - `Read`, `Edit`, `Write`, `MultiEdit`, `NotebookEdit`: the file's path relative to the attempt's worktree, with `/` separators, or `outside` when it is not inside the worktree. A path in which `findSecrets` finds a secret (ADR 0088) shows as `(left out)`.
    - `Bash`, `PowerShell`: the command's first one or two plain words, read by the same function and rule as a receipt's denied prefixes (ADR 0172, `prefixOf`), which moves where both the receipt and the live line import it. No plain first word shows the tool's name alone.
    - any other tool: its name alone.
    Never the rest of a command, a tool's other input, a tool's result or any text the model wrote.
  - `denied` when a denial came since the last redraw.
  A check step's attempt (no brewer stream) shows the step, attempt and elapsed time only.
- **Several running attempts** (a parallel group, ADR 0168) share the one line, joined by ` ; `, in the order the plain lines name them.
- **The line:** an ASCII spinner, `| / - \`, then the attempts. Every part goes through `printable` and the line-break escape `brew` already applies (ADR 0123), and the whole line is cut to `process.stdout.columns` (80 when it is unknown), so it never wraps and a carriage return always returns to its start. It is redrawn about once a second by a timer of its own, apart from the 5-s tick, and again when the terminal is resized.
- **Lasting lines** (a change, a notice, the status comment's link, the end, a question) clear the live line (`\r` and `ESC [2K`), print, and draw it again. Before `brew` exits, on any exit code, on a stop and on Ctrl+C, it clears the live line, so the last lines on screen are today's.
- **Where the values come from:** the runner's progress of a running attempt (ADR 0027, ADR 0047) gains what the line needs: the turn, the last tool call reduced to its name and safe word, and a count of denials. The supervisor reads it as before and ignores the rest. The reduction happens in the runner, so the raw input never reaches the command line's code.
- **`brew` only.** `foedrum serve` keeps its plain lines: it runs many batches as a service, and a board of batches belongs to `foedrum status --watch` (#463) and the Brewhouse.
- **Built-in only** (ADR 0004): `isTTY`, `columns`, the `resize` event, `\r` and one ANSI sequence. No spinner or terminal package.

```
foedrum brew: batch 8-1 brewing: gauge #1 started
| implement #1 / 2m 41s / turn 14 / Edit src/schemas/primitives.ts
```

## Consequences
- In a terminal, a brew shows each second that it lives and what the brewer does. A session, a log or CI sees the same lines as before; a regression test keeps the plain output equal to today's.
- The latest context size and the output tokens, which the comment on #442 also listed, are left out of the line; the receipt has the tokens when the attempt ends (ADR 0172). Adding them later reads the same progress.
- `prefixOf` has two callers. A change to the rule changes both the receipt and the line, which is the point: one reading of a command.
- On Windows, Node writes a console through libuv, which passes `\r` and `ESC [2K` to a console that understands them (Windows Terminal, conhost on Windows 10 and later, the VS Code terminal) and acts them out itself on one that does not. `TERM=dumb` still turns the line off for a terminal that misreads them.

## Alternatives considered
- **The tool's full input, escaped:** rejected. It is model-written text from an untrusted order on someone's screen, and the escaping only keeps it on one line; one safe word says enough to tell a brewer that works from one that is stuck.
- **A braille spinner and a middle dot, as in #442's sketch:** rejected. A Windows console's code page may not show them, as `foedrum status` found (ADR 0172).
- **The same line in `serve`:** rejected. A service's output is mostly read as a log.
