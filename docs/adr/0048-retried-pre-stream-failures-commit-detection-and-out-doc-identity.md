# 0048. Retried failures before the stream, commit detection, and the out doc's identity

Date: 2026-10-17 · Status: Accepted · Amends [0047](0047-the-claude-brewer-runner-its-stream-endings-and-progress.md)

## Context
The consultant's review of #133 left follow-ups that were not blocking (#134):
- **Item 1.** ADR 0047 makes every exit before the first stream line (code 1 to 255) the environment: a network failure while `claude` starts gets the batch Stuck.
- **Item 2.** Progress counted any shell command with `git` and later `commit` in it, such as `git log --grep commit` or `echo git commit`.
- **Item 3.** The out doc is checked by its real path and then opened with `O_NOFOLLOW`, which covers only the last part of the path: a folder swapped in between hands the runner another file.

## Decision

### A failure before the stream is retried once
- When `claude` exits with a code from 1 to 255 before writing any stream line, the runner reads its stderr. A refusal it will repeat goes to the environment at once, as ADR 0047 decided: an unknown option or a missing argument, an option that requires another (`requires --verbose`), an invalid session id or one already in use, no login or an invalid API key (`Please run /login`).
- Any other such failure (a network error, a crash with a small code) may pass. The runner waits 5 s, through its new `wait` dependency, and starts `claude` once more with the same command line and prompt. A second failure before the stream is the environment. A stop during the wait, or one that came before it began, cancels the attempt without waiting.
- The session id is reused. A start that wrote no line has not taken it; a start that wrote its stream has, and a second start with that id is refused with `Session ID <id> is already in use.`, but such a start is never retried. Checked against `claude` 2.1.301 when this was decided, with the fake Messages API of `test/integration/`: a start killed before its first line, then a second start with the same id, which ran.

### Commit means git's subcommand
- A shell command counts as a commit for the stall watchdog only when one of its simple commands (split at `;`, `&`, `|` and line ends outside quotes) is `git` itself, by any path and with or without `.exe`, after optional `NAME=value` variables, and the first word after git's global options is `commit`. `-C`, `-c`, `--git-dir`, `--work-tree`, `--namespace` and `--config-env` take the next word as their value. A quoted word is one word.
- Each step is linear in the command's length: the command is model output (ADR 0047).

### The out doc read is the file checked
- The runner takes the device and file id of the real path it checked (`stat`) before it opens the out doc, opens it by that path, and compares them with those of the open file (`fstat`), as big integers because a Windows file id may not fit a number. The identity must come from before the open: a folder swapped for a link after the check is followed by the open and by any later look at the same path, so a `stat` after the open would see the swapped file too. After the open it also resolves the real path again: a swap that came before the identity was taken, and is still in place, moved it. When either differs, it does not read the out doc: *it changed while it was read*. The type, link count and size checks use the open file too.
- **This narrows the window, it does not close it.** A swap made and undone between the containment check and the second real path, while the open happens, is not seen. Node has no way to open a path one folder at a time without following links (`openat` with `O_NOFOLLOW` on each part), which would close it. A brewer needs a process that outlives `claude` and races the runner within a few system calls; the sandbox (ADR 0010) and the Job Object on Windows (ADR 0039) make that harder.

## Consequences
- A network failure at start costs 5 s and one more process start, and no longer gets a batch Stuck. A lasting refusal still does at once. A `claude` message that is lasting but not on the list costs one retry before it reaches the environment.
- The commit check misses a commit through an alias (`git ci`) or a wrapper script; the brewer's next file write or a later commit counts.
- Foedrum relies on `claude`'s documented flags and does not track which `claude` versions it ran against, as for git: the checks against the CLI named in this ADR and in ADR 0046 record what was true when they were decided.

## Alternatives considered
- **Retry every failure before the stream, lasting refusals too:** simpler, but it spends a start and 5 s on what will fail again.
- **Leave a passing failure to the next attempt** (retryable, `maxAttempts`): no wait in the runner, but a brewer with one attempt would get Stuck as `attempts_exhausted`, and the next attempt could not tell a second network error from a first.
- **A fresh session id for the second start:** avoids any reuse, but the engine chose and may have recorded the first id (ADR 0047), and the check above shows the reuse is safe for the only start that is retried.
- **Parse the command with a shell grammar:** exact, but large and not linear; the simple-command split covers what brewers write.
- **Warn about a `claude` outside the versions the settings proof ran against** (#128): dropped. Foedrum does not test whether third-party tools work; it relies on their documented flags.
