# 0174. `foedrum brew` keeps a live line on a terminal

Date: 2026-10-24 · Status: Accepted · Amends [0123](0123-foedrum-brew-drives-one-batch-under-an-owner-of-its-own.md) (what `brew` prints when its standard output is a terminal) and [0047](0047-the-claude-brewer-runner-its-stream-endings-and-progress.md) (the runner's progress of a running attempt also says what it did last, for display)

## Context
`foedrum brew` prints a line when the batch's lane or step changes and, while a step runs, `batch <id> brewing: <step> #<n> running for <time>` every 30 s (`PROGRESS_MS`, #406). Its loop ticks every 5 s (`INTERVAL_MS`). In a terminal the screen stands still for those 30 s, so a brew looks stuck while the brewer works (the third brew, Brewery issue #8).

Tools that run for minutes keep one line alive instead: a spinner and a counter rewritten in place (npm, pnpm), or what the worker does now (`gh run watch`), and only when standard output is a terminal. Everything such a line could say about a claude brewer is already in the stream the runner reads (ADR 0047): the turns, each tool call with its input, and each denial, which arrives mid-run as a system event. The tool's input is text a model wrote from an untrusted order, and a terminal acts on control and bidirectional characters, so what of it is shown is a security choice, not a layout one. The details were settled with the maintainer on #442 (2026-10-24).

## Decision

### When
`brew` draws the live line only when standard output is a TTY, `TERM` is not `dumb`, and `CI` is not set. Otherwise it prints what it prints today, every 30 s, byte for byte: a pipe, a log, the plugin in a Claude Code session (ADR 0125) and CI read no control characters. The line uses no colour, so `NO_COLOR` changes nothing.

### What one running attempt shows
In this order, joined by ` / `:
- the step and attempt (`implement #1`);
- its elapsed time, written and counted as the plain lines do: from when `brew`'s loop first saw the attempt running (`seenAt`), for a brewer's attempt and a check step's alike, so the two outputs never disagree;
- for a brewer attempt, its turn (`turn 14`), counted as ADR 0047 counts turns: the main thread's messages;
- what it did last: the latest tool call of the main thread (a call with no `parent_tool_use_id`; a subagent's calls are not shown, as they do not count as turns), as its name and, for some tools, one safe word:
  - `Read`, `Edit`, `Write`, `MultiEdit`: the input's `file_path`; `NotebookEdit`: its `notebook_path`. Shown relative to the attempt's worktree with `/` separators, or as `outside`. The test is lexical: the path resolved against the worktree, then made relative to it, is outside when the result starts with `..` or is absolute (another drive or root). No file is read for it. A path in which `findSecrets` finds a secret (ADR 0088) shows as `(left out)`.
  - `Bash`, `PowerShell`: the command's prefix as the stream reader already reads it for a receipt's denials (ADR 0172, `prefixOf`, kept with each call). With no prefix, the tool's name alone.
  - any other tool: its name alone.
- `denied`, from any denial in the attempt (a subagent's call's too) until the attempt's next main-thread tool call: so it stays on while the brewer is held up by the refusal and goes once it works on.

The tool's name and the path are the only model-written text on the line; nothing else of a call's input, no tool result and no other text the model wrote is shown.

While the repository's setup runs (no claude yet), the line shows `setup` in place of the turn and the tool. A check step's attempt, which has no brewer stream, shows the step, attempt and elapsed time only.

Several running attempts (a parallel group, ADR 0168) share the one line, joined by ` ; `, in the order the plain lines name them.

### The line's text
An ASCII spinner, `| / - \`, then the attempts. The line is ASCII only: in every part, each code point outside U+0020 to U+007E is shown as a `\uXXXX` escape (each UTF-16 unit for one above U+FFFF), which covers what `printable` covers and also bidirectional overrides and isolates, zero-width and wide characters. The tool's name is cut to 64 characters before it is escaped. After escaping, every character is one column, so the whole line is cut to the terminal's width less one (`columns - 1`, 79 when it is unknown) by counting characters. It never wraps, so a return to the line's start always reaches all of it.

### Drawing it
- It is redrawn about once a second, on the shell's `wait` and `clock` (no wall clock, as CLAUDE.md requires for tests), apart from the 5-s tick, and again when the terminal is resized.
- To redraw, `brew` goes to the line's start and clears it with Node's `tty.WriteStream` `cursorTo(0)` and `clearLine(0)`, then writes the line without a line feed. No escape sequence is written by hand, so on Windows the console behaviour is Node's.
- A lasting line (a change, a notice, the status comment's link, a question, the end) clears the live line, is printed, and the live line is drawn again. Before `brew` exits, on any exit code, a stop and Ctrl+C, the live line is cleared, so the last lines on screen are today's.

### Where it comes from
- **The runner** (ADR 0027, ADR 0047): `AttemptProgress` gains optional fields, which the claude runner fills from its stream reader: `turn`, `lastTool` (the name and safe word, already reduced) and `denied` (whether a denial came after the latest main-thread call), plus `settingUp`. The supervisor reads it as before and ignores them. The check runner and the tests guard report no such fields. The reduction happens in the stream reader, so a tool call's raw input never leaves it: the runner passes the attempt's worktree into the reader's `StreamAsk`, which it already builds, so the reader can make a path relative to it.
- **The driver** gains `progress(ref)`, which passes through to the runner it already holds (as `step-runner.ts` joins the check runner's and the brewer runner's). `brew` reads it for each running attempt.
- **The terminal** comes through the shell: `ServeShell` gains an optional `terminal`, present only when the rule under *When* holds, with its `columns`, a resize subscription, and a way to clear and rewrite the current line. `runBrew` draws the live line when `terminal` is present and prints the plain lines when it is not; tests give a fake terminal, clock and `wait`.

### Scope
- **`brew` only.** `foedrum serve` keeps its plain lines: it runs many batches as a service, and a board of batches belongs to `foedrum status --watch` (#463) and the Brewhouse.
- **Built-in only** (ADR 0004): `isTTY`, `columns`, the `resize` event, `cursorTo` and `clearLine`. No spinner or terminal package.

```
foedrum brew: batch 8-1 brewing: gauge #1 started
| implement #1 / 2m 41s / turn 14 / Edit src/schemas/primitives.ts
```

## Consequences
- In a terminal, a brew shows each second that it lives and what the brewer does. A session, a log or CI sees the same lines as before; a regression test keeps the plain output equal to today's.
- A path with non-ASCII characters shows with escapes on the live line. That is the price of a line that cannot be reordered or made to wrap by the text a model wrote.
- The latest context size and the output tokens, which the first comment on #442 also listed, are left out; the receipt has the tokens when the attempt ends (ADR 0172). Adding them later reads the same progress.
- The live line's prefix is the receipt's: the stream reader reads a shell command's start once, by one rule, for both.

## Alternatives considered
- **The tool's full input, escaped:** rejected. It is model-written text from an untrusted order on someone's screen; one safe word says enough to tell a brewer that works from one that is stuck.
- **`printable` alone for the line:** rejected. It escapes control characters only, so a bidirectional override in a path could reorder the line and wide characters would make the cut to the terminal's width wrong.
- **A braille spinner and a middle dot, as in #442's sketch:** rejected on #442, in line with the ASCII separator `foedrum status` uses (ADR 0172).
- **The same line in `serve`:** rejected. A service's output is mostly read as a log.
