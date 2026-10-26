# 0222. A recipe's brewer step may be interactive: `foedrum brew` opens its session in the terminal, `serve` waits for one

Date: 2026-10-26 · Status: Accepted · Amends [0019](0019-interactive-sessions-and-one-command-layer.md) (the `session` step and its kinds give way to an interactive brewer step, without a fallback), [0006](0006-no-mid-run-questions.md) (an interactive step's brewer talks to a person in its session), [0123](0123-foedrum-brew-drives-one-batch-under-an-owner-of-its-own.md) (brew opens sessions on a terminal, and picks up a batch that waits for one), [0125](0125-the-foedrum-plugin-is-markdown-skills-that-run-the-terminal-with-via-plugin.md) (`/foedrum:brew` opens a new terminal window for a session), [0126](0126-foedrum-resume-opens-a-finished-attempt-s-session-in-its-worktree.md) and [0127](0127-foedrum-resume-takes-a-running-batch-over-and-continues-its-step-s-session.md) (the foreground runner opens a new session too), [0053](0053-recipe-files-reach-the-engine-brewer-steps-in-a-line-first.md) (the session step it refused at load is gone from the schema), [0117](0117-a-retry-resumes-the-session-of-the-attempt-before-it-in-that-attempt-s-worktree.md) (a retry of an interactive step starts a fresh session, whatever its `retryMode`), [0025](0025-batch-lifecycle-stuck-reminders-and-rewind.md) (an attempt that never started counts against no retry) and [0027](0027-supervisor-lost-and-stalled-attempts.md) (no deadline judges an open session)

## Context
Some steps need a person in the conversation: gate 1's plan corrections in a lauter session (#388, #390), later triage and review discussions.
[ADR 0019](0019-interactive-sessions-and-one-command-layer.md) designed a `session` step for them (`{ "id": "analyze", "session": "refine" }`) with three fixed kinds, `refine`, `triage` and `review`, and an automated `fallback` brewer.
The recipe schema accepts it, but the loader refuses it ("the engine does not brew yet", [ADR 0053](0053-recipe-files-reach-the-engine-brewer-steps-in-a-line-first.md)), so no event log holds one, and no default recipe uses it.
The kinds name no brewer, so a session step had no model, tools, guards or out doc of its own.
`foedrum resume` ([ADR 0126](0126-foedrum-resume-opens-a-finished-attempt-s-session-in-its-worktree.md), [ADR 0127](0127-foedrum-resume-takes-a-running-batch-over-and-continues-its-step-s-session.md)) already runs an attempt as an interactive `claude` in the foreground, with the attempt's settings and guards, and ends it by the out doc the session wrote.
The maintainer decided on 2026-10-26 (#569): any brewer step can be interactive, with its first prompt in the recipe; the word is "interactive"; it runs with its brewer's model, tools, guards and out doc; `foedrum brew` runs it in the foreground; a session closed without a valid out doc waits for a person again and never runs headless; under `serve` it waits Stuck "waiting for a session"; an open session has no deadline; and `/foedrum:brew` opens it in a new terminal window.

Claude Code's documentation, checked on 2026-10-26:

- The CLI reference (code.claude.com/docs/en/cli-reference) lists `claude "query"` as "Start interactive session with initial prompt".
- Its `--session-id` row, "Use a specific session ID for the conversation (must be a valid UUID)", carries no print-only qualifier, where the print-only flags in the same table say "Only applies in non-interactive mode with `-p`". The documentation does not say in words that it works in an interactive session; the maintainer's tryout confirms it.
- The permissions page (code.claude.com/docs/en/permissions) writes an absolute path in a Read rule as `//path` ("`//path` | Absolute path from filesystem root | `Read(//Users/alice/secrets/**)`"), and "On Windows, paths are normalized to POSIX form before matching. `C:\Users\alice` becomes `/c/Users/alice`".
- Read-only tools need no approval "within the working directory and additional directories"; outside them, an interactive session asks. With `blockReadsOutsideWorkingDirectories`, which the sandboxed level sets ([ADR 0160](0160-sandboxed-commands-read-only-inside-the-working-directories.md)), "the file tools refuse reads outside the working directories in every permission mode"; whether an allow rule for one file passes that block is not documented, and the tryout checks it.
- `--setting-sources` and `--safe-mode` carry no print-only qualifier either; `foedrum resume` has run interactive sessions with both since ADR 0126.

## Decision

### The recipe
- A brewer step may say **`"interactive": true`** with a **`"prompt"`**, the Brewery's first message to the session: `{ "id": "lauter", "brewer": "maltster", "interactive": true, "prompt": "…" }`.
  `interactive` is only the literal `true`, and `prompt` is non-empty text of at most 4 KiB; the schema refuses either without the other, and every other step kind refuses both (strict objects).
- The loader refuses an interactive step in a parallel group (Tasters side by side, [ADR 0168](0168-a-parallel-group-runs-its-lens-steps-side-by-side.md), and one terminal) and one with a `lens` (a lens step is a Taster's headless review).
- **The `session` step goes**: `SessionStep`, the `session` kind and the `fallback` brewer are removed, and the schema refuses a step with `session` with a message that names `"interactive": true` on a brewer step.
  An interactive step never runs headless, so there is nothing to fall back to.
- The step keeps its brewer's (or its own) `deadline`, which holds until its session opens (below).

### The prompt
- The recipe's `prompt` joins the brewer's instructions after the brewer file's body and before the round texts and the out doc contract; the inputs follow in their nonce tags, as for every attempt ([ADR 0041](0041-untrusted-input-in-per-prompt-nonce-tags.md)).
- The runner writes that whole prompt to **`<attempt>.prompt.md`** beside the attempt's settings file, as the system prompt file is written ([ADR 0183](0183-the-engine-s-fixed-rules-for-a-brewer-go-in-an-appended-system-prompt.md)), and the attempt's settings allow Read of that file alone (`Read(//<its path in POSIX form>)`).
- claude's first message on the command line is a fixed engine line, `Read <that file>: it is your task in this session.`, so the command line holds only the engine's text and work-root paths, which pass the `.cmd` pattern ([ADR 0031](0031-cmd-and-bat-files-through-cmd-exe.md)).
- What the person types afterwards is the conversation and is never recorded; only the out doc reaches the log.

### Who opens it, who parks it
- A driver opens sessions only when it is given **`sessions`**: `foedrum brew` on a terminal.
  `serve`, `resume` and brew without a terminal open none.
- A driver without sessions does not start a scheduled attempt of an interactive step: it issues **`await_session { batchId, stepId, attempt }`**, which `decide` accepts only for the latest attempt of an interactive step, scheduled and not started, and turns into `batch.stuck` with the reason `waiting_for_session` and its usual options (`retry`, `skip`, `recipe`, `rewind`, `cancel`).
  Its reminder is the wait's deadline (ADR 0025).
- **An attempt that never started counts against no retry**: an attempt a Stuck abandoned while it was scheduled is left out of the count, as a paused one is ([ADR 0202](0202-pause-and-continue-hold-an-order-or-the-whole-brewery-at-its-next-convenient-point.md)).
  This holds for every step: a stop or a blocker that abandons a scheduled attempt costs the step no attempt either.
- **A session closed without a valid out doc** (none, invalid, or claude exited non-zero without one) fails the attempt retryably, as every run does; for an interactive step that still has an attempt, `decide` then makes the batch Stuck `waiting_for_session` instead of scheduling a retry, so a person who closed claude does not get it back in a loop.
  A lost attempt of an interactive step goes the same way.
  With no attempt left, the batch is Stuck `attempts_exhausted`, as for every step.

### `foedrum brew` and the terminal
- brew opens sessions when stdin is a terminal and it does not run inside Claude Code (`CLAUDE_CODE_CHILD_SESSION=1`), as resume reads them.
- Otherwise it still brews: the batch's other steps run headless, and at the interactive step its driver parks the batch as serve's does; brew exits 3 with the reason and one line, `run foedrum brew <issue> in a terminal` inside Claude Code, or `stdin is not a terminal, and claude needs one`.
  A recipe whose interactive step a `when` skips, or a script that brews up to that step, keeps working.
- With a terminal, the runner opens an **interactive step's attempt** in the foreground: `claude` with `--session-id <the recorded id>`, the brewer's model, effort, tools, settings and system prompt file, the same guards as `resumeArgs`, and the fixed first message; no print-mode flag and no `dontAsk`, so what the settings do not allow is asked.
  The runner chooses by the step, never by the plan's session kind: every other attempt, a `retryMode: resume` retry included, runs headless as before, and a retry of an interactive step starts a fresh session with the whole prompt (it has no claude init report to resume, ADR 0127).
- While claude has the terminal, brew's lines wait, its live line ([ADR 0174](0174-foedrum-brew-keeps-a-live-line-on-a-terminal.md)) is not drawn, and Ctrl+C is claude's, as for resume.
- A valid out doc settles the attempt through `settleAttempt` as every run (a `done` of a brewer that commits needs a commit, the commits are scanned, claude's exit code counts), and the recipe goes on in the same brew.
  Closed without one, brew exits 3 with `run foedrum brew <issue> again to reopen the session`.
- **A batch already waiting**: when brew with a terminal finds its batch Stuck `waiting_for_session` at its start, it records the person's `retry` (with brew's `by` and `via`) and drives on, so the session opens; within one run it never retries by itself.
  A batch serve parked is held by serve's lease, so the reason's lines (brew's exit-3 line, `foedrum status`, the status comment) name `foedrum brew <issue> --take` in a terminal ([ADR 0124](0124-foedrum-takeover-hands-a-batch-to-another-driver-as-a-recorded-command.md)).

### No deadline while the session is open
- **An open interactive session has no deadline**: it is a person's wait, the fourth written exception to "every wait has a deadline", beside a person's pause (ADR 0202), a blocked sub-order ([ADR 0211](0211-the-intake-starts-ready-sub-orders-at-their-order-s-rank-once-their-blockers-merged.md), [ADR 0216](0216-a-release-blocker-is-done-once-its-repository-is-released-after-its-merge.md)) and an open pull request's checks ([ADR 0213](0213-an-open-pull-request-s-checks-on-its-head-are-recorded-once-they-finish.md)).
- The supervisor does not expire a started attempt of an interactive step, and the runner reports progress while the session is open, so no stall limit judges a person.
- What still ends the wait: the person closing the session, whose out doc settles the attempt; the attempt's lease when foedrum itself dies ([ADR 0044](0044-batch-leases-held-by-the-driver-and-one-command-log.md)), after which the supervisor loses the attempt and the batch waits for a session again; and a person's `stop` or `cancel`, after which what the session writes is not read.
- The wait is never silent: `step.started` of an interactive step records **`interactiveSince`**, and the status comment says `session open since <time>` on the step's line.
- Before the session opens, a batch parked Stuck `waiting_for_session` has the Stuck reminder as any Stuck batch.

### Leases and takeovers while it is open
- brew holds the batch's lease and the attempt's, renewed by its heartbeat as for every run, so serve skips the batch.
- A takeover (`foedrum takeover`, `brew --take`) moves the batch at once; the old brew starts nothing more, its open session runs on (a stop does not end it), and its end is recorded at the step boundary also in the batch it lost, as ADR 0124 and ADR 0127 have it.
- `foedrum resume <batch> [<step>]` of an interactive step whose attempt is open takes the batch over as ADR 0127 has it: the open session cannot be stopped from outside, so resume waits until the person closes it.
  Refusing it at once, with a line that names the driver holding it, is a follow-up.
  resume of a finished interactive attempt works as ADR 0126.
- A foedrum killed with claude open leaves claude to the person; its out doc is never read.

### Windows
- The session runs through `foregroundProcess` unchanged: in foedrum's console and process group, stdio inherited, no Job Object ([ADR 0039](0039-windows-job-objects-through-a-powershell-helper.md) and [ADR 0047](0047-the-claude-brewer-runner-its-stream-endings-and-progress.md) are for headless runs, whose tree the runner kills; Foedrum never kills a person's session).
- Every argument passes `windowsCommandLine` for npm's `claude.cmd`; the prompt never goes on the command line.
  cmd.exe asks "Terminate batch job (Y/N)?" after a Ctrl+C in `claude.cmd`, as for resume, and Git Bash's mintty without a console is no terminal.

### The plugin
- When `/foedrum:brew` sees brew exit 3 with a batch waiting for a session, it runs **`foedrum brew <issue> --new-window`**, which opens a new terminal window running `foedrum brew <issue> --take --as <owner>` (the same node and `foedrum` program, as the owner this brew resolved, since a window may start with none of the session's variables), and tells the engineer the step opened in a new window and to run `/foedrum:status` after closing it.
  It launches `foedrum brew`, never `claude`, so the lease, the attempt's settings and the out doc check stay Foedrum's; `--take` hands the batch over.
  The launcher gets this process's environment without `CLAUDE_CODE_CHILD_SESSION` and `CLAUDE_CODE_SESSION_ID`, so the window's brew reads as a terminal's and opens the session.
- The launcher is part of the `foedrum` program, not a script of the skill: one function per platform with argument arrays and no shell of its own, tested with a fake spawner, and it works the same for a terminal user.
  Windows: `wt.exe new-tab` when Windows Terminal is on the PATH, else `cmd.exe /c start`, with cmd.exe by its full path under `SYSTEMROOT` and `NoDefaultCurrentDirectoryInExePath` set, as the process runner starts it; macOS: `osascript` telling Terminal to run the line; Linux: `$TERMINAL`, else `x-terminal-emulator`, with `-e`, through `setsid -f`, so the launch returns while the window stays open; without `setsid` no window opens.
- The launcher starts through `launchProcess` (`src/platform/processes.ts`): stdio ignored, detached (out of foedrum's process group, and on Windows out of the kill-on-close job node puts its children in), settled on its exit, within 30 s. Through `execProcess` the window would hold the launcher's output pipes, so the launch would wait for the window, and on Windows the window cmd.exe's `start` opens would end with foedrum.
  A launcher that exits 0 has asked for the window, which only the window shows opened (a `$TERMINAL` that takes `-e` otherwise fails after `setsid -f` returned), so brew says it asked for one and names the command to run in a terminal if none opened.
- Where no window can be opened (an SSH session, no display on Linux, no launcher found) it prints the command to run in a terminal and exits 5.
  Opening a real window is the maintainer's tryout, never a test.

## Consequences
- A recipe asks for a person in the conversation with two fields on any brewer step, and the session has that brewer's guards and out doc.
- Under serve, an interactive step costs a Stuck batch and a reminder until a person runs `foedrum brew <issue> --take` in a terminal.
- A laptop closed on an open session holds the batch, with no deadline, until a person notices it on the board (`session open since …`) or foedrum dies and the lease runs out.
- A reopened session starts fresh: what the person said in the closed one is lost, though `foedrum resume <batch> <step>#<n>` still opens it for reading. Resuming it on reopen is a follow-up.
- A step whose scheduled attempt a Stuck abandoned no longer loses that attempt from its `maxAttempts`.

## Alternatives considered
- **Read the `session` step as an alias**: `refine`, `triage` and `review` name no brewer, so an alias would need a brewer table the engine does not have, and two spellings of one thing would stay forever. **Keep it beside**: two step kinds for one wait.
- **The whole prompt as claude's command-line argument**: free text and line breaks are refused for `claude.cmd` (ADR 0031), and Windows caps a command line. **On stdin**: stdin is the terminal's. **In the system prompt file**: it holds the engine's fixed rules, and untrusted inputs there would gain their weight. **In the worktree**: a brewer that commits would commit it, and could edit it.
- **`decide` parks every interactive step**: a driver with a terminal would un-park it every time, two events for nothing. **The supervisor parks it**: it does not know what a driver can open, and the start is the driver's moment.
- **brew refuses without a terminal up front**: a recipe whose interactive step a `when` skips, or a script that brews up to that step, would never run.
- **Ask the person to run `foedrum retry` first**: serve's driver would park the new attempt again before brew took the batch. **serve drops the lease of a waiting batch**: a new lease rule, and the reminders follow the holder.
- **A retry that reopens the session at once**: a person who closed claude would get it back in a loop. **Resume the closed session on reopen**: it has no init report, and a lost one's process may still run.
- **A deadline on the open session**: it would end a person's work mid-conversation; the lease already ends it when foedrum dies.
- **Run the step in the plugin's own Claude Code session**: the engineer's model, tools and permissions, not the brewer's guards and out doc. **Open claude through `!`**: it cannot hand the terminal over (ADR 0126). **A launcher script in the skill**: a script per shell, untested, and of no use to a terminal user.
