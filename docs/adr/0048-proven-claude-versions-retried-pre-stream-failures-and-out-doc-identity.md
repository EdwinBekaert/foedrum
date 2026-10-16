# 0048. Proven claude versions, retried failures before the stream, and the out doc's identity

Date: 2026-10-17 · Status: Accepted · Amends [0046](0046-only-the-runners-settings-the-init-check-and-a-line-by-line-stream.md) and [0047](0047-the-claude-brewer-runner-its-stream-endings-and-progress.md)

## Context
The consultant's reviews of #127 and #133 left follow-ups that were not blocking:
- **#128.** The proof that `--setting-sources ""` keeps the user's settings away from a brewer (ADR 0046) ran against `claude` 2.1.301 only, and CI does not run it. Nothing tells a user whose `claude` has moved on.
- **#134, item 1.** ADR 0047 makes every exit before the first stream line (code 1 to 255) the environment: a network failure while `claude` starts gets the batch Stuck.
- **#134, item 2.** Progress counted any shell command with `git` and later `commit` in it, such as `git log --grep commit` or `echo git commit`.
- **#134, item 3.** The out doc is checked by its real path and then opened with `O_NOFOLLOW`, which covers only the last part of the path: a folder swapped in between hands the runner another file.

## Decision

### The proven claude versions
- `PROVEN_CLAUDE` (`src/brewers/claude-version.ts`) is the range of `claude` versions that `test/integration/claude-cli.test.ts` passed on, both ends included: today 2.1.301 to 2.1.301. Versions compare as three numbers; anything else is not proven.
- `foedrum doctor` reports another version as a problem that does not fail it: *claude 2.2.0 is not a version Foedrum proved its brewer settings on (2.1.301)*, with the advice to keep `permissions.allow` and `env` out of the user's Claude Code settings until a Foedrum release proves it.
- The runner warns once per version through its new `warn` dependency, when an init shows an unproven one. It does not refuse: the init check of ADR 0046 still catches a changed session, and refusing every new release would stop brewers on the day `claude` updates.
- The range is widened only after the proof passed on the new version, in the same change.

### A failure before the stream is retried once
- When `claude` exits with a code from 1 to 255 before writing any stream line, the runner reads its stderr. A refusal it will repeat goes to the environment at once, as ADR 0047 decided: an unknown option or a missing argument, an option that requires another (`requires --verbose`), an invalid session id, no login or an invalid API key (`Please run /login`).
- Any other such failure (a network error, a crash with a small code) may pass. The runner waits 5 s, through its new `wait` dependency, and starts `claude` once more with the same command line and prompt. A second failure before the stream is the environment. A stop during the wait cancels the attempt.
- The session id is reused: a `claude` that wrote no line did not set up the session.

### Commit means git's subcommand
- A shell command counts as a commit for the stall watchdog only when one of its simple commands (split at `;`, `&`, `|` and line ends) is `git` itself, by any path and with or without `.exe`, after optional `NAME=value` variables, and the first word after git's global options is `commit`. `-C`, `-c`, `--git-dir`, `--work-tree`, `--namespace` and `--config-env` take the next word as their value. A quoted word is one word.
- Each step is linear in the command's length: the command is model output (ADR 0047).

### The out doc read is the file checked
- The runner opens the out doc by its real path, then compares the open file's device and file id (`fstat`) with those of the real path it checked (`stat`), as big integers because a Windows file id may not fit a number. When they differ, it does not read the out doc: *it changed while it was read*. The type, link count and size checks use the open file too.

## Consequences
- A user on a newer `claude` sees a warning in `foedrum doctor` and in the engine's output until Foedrum proves that version. Updating `PROVEN_CLAUDE` is part of moving to a new `claude`.
- A network failure at start costs 5 s and one more process start, and no longer gets a batch Stuck. A lasting refusal still does at once. A `claude` message that is lasting but not on the list costs one retry before it reaches the environment.
- The commit check misses a commit through an alias (`git ci`) or a wrapper script; the brewer's next file write or a later commit counts.

## Alternatives considered
- **Refuse brewers on an unproven `claude`** (the consultant's other option): safe, but it would stop every Brewery on the day `claude` updates, for a risk that only a user settings file with `permissions.allow` or `env` brings.
- **Retry every failure before the stream, lasting refusals too:** simpler, but it spends a start and 5 s on what will fail again.
- **Leave a passing failure to the next attempt** (retryable, `maxAttempts`): no wait in the runner, but a brewer with one attempt would get Stuck as `attempts_exhausted`, and the next attempt could not tell a second network error from a first.
- **Parse the command with a shell grammar:** exact, but large and not linear; the simple-command split covers what brewers write.
