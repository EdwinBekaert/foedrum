# 0123. `foedrum brew` drives one batch under an owner of its own

Date: 2026-10-22 · Status: Accepted · Amends [0019](0019-interactive-sessions-and-one-command-layer.md) (what the interactive driver is before the plugin), [0037](0037-attempt-worktrees-in-the-engine-and-driver-locks.md) (an interactive session's owner), [0044](0044-batch-leases-held-by-the-driver-and-one-command-log.md) (the owner left for later, and a command that changes state may open the store as a driver does) and [0063](0063-foedrum-serve-its-configuration-and-wiring.md) (the wiring is shared, and a driver that runs until it stops can be a command of the registry)

## Context
[ADR 0019](0019-interactive-sessions-and-one-command-layer.md) has two drivers on one engine: the Cellar (`foedrum serve`) and an engineer's session, which brews one order without a Cellar running, or beside one. [ADR 0044](0044-batch-leases-held-by-the-driver-and-one-command-log.md) built the driver for both (`openDriver`, `takes`), and [ADR 0063](0063-foedrum-serve-its-configuration-and-wiring.md) wired it up for the Cellar only. #37 asks for the interactive one; #334 is its first part: `foedrum brew <order>`, which the plugin's session runs (#336). Four things were open:

- **The owner.** A driver's owner names its lock and its leases, and must stay the same across its restarts, or `expireOwnLeases` never finds the leases of its earlier run ([ADR 0037](0037-attempt-worktrees-in-the-engine-and-driver-locks.md)). For a session it must also stay the same when the engineer resumes it, so that `foedrum brew` after `foedrum answer` drives on the batch its earlier run still leases.
- **When it stops**, and how the session that runs it knows why.
- **What it prints.**
- **How it shares serve's wiring** without a second copy of it.

What a command run from a Claude Code session can know about that session was checked in Claude Code's docs (code.claude.com, 2026-10-22):

- **Environment variables, `CLAUDE_CODE_SESSION_ID`:** "Set automatically to the current session ID in Bash and PowerShell tool subprocesses, hook command subprocesses, and stdio MCP server subprocesses. For Bash, PowerShell, and hooks this matches the `session_id` field in the hook JSON input and is updated on `/clear`. […] On `--resume <session-id>` it receives the resumed ID, matching hooks and Bash. On `--continue` or `--resume` without an explicit ID it may receive the initial startup ID instead."
- **`CLAUDECODE`** is set to `1` in the same subprocesses and also in an IDE's integrated terminal, so it says only that a command may run under Claude Code, not which session. **`CLAUDE_CODE_REMOTE_SESSION_ID`** and **`CLAUDE_CODE_BRIDGE_SESSION_ID`** exist only in cloud and Remote Control sessions.

So a command run by the session's own tools reads its session's id, which `--resume <id>` keeps, while `/clear` changes it and a resume without an id may not give it back.

## Decision

### The command
- **`foedrum brew <issue> [--as <name>]`** is a command of the registry that changes state (`BrewCommand`, `src/schemas/commands.ts`). `<issue>` is what `foedrum order` takes ([ADR 0105](0105-foedrum-order-orders-an-issue-again-as-a-human-command-recorded-on-batch-ordered.md)): `<alias>#<n>`, `#<n>` or `<n>`.
- Its batch is the issue's latest batch while that one is live. An issue with **no batch** is ordered first, through the same `orderIssue` as `foedrum order` (a target issue is claimed first), and the order is recorded with who ran it and from where. An issue whose latest batch **ended** (on tap, cancelled) is refused: ordering it again is `foedrum order`'s, a person's decision.
- An **Ordered** batch is routed by its issue's one `recipe:<name>` label, as the intake routes it ([ADR 0068](0068-the-intake-in-foedrum-serve-brewery-orders-and-routing-by-label.md)), read through gh. An issue with no such label, with two, or with one that names no recipe of the Brewery, is refused before anything is ordered or claimed.
- **A command of the registry, although it runs until its batch stops.** [ADR 0063](0063-foedrum-serve-its-configuration-and-wiring.md) kept `serve` out of the registry because it runs until it is stopped and no comment or dashboard could issue it. `brew` runs until one batch stops, and the plugin issues it through the terminal (#336), as ADR 0019 lists it among the commands. It is a command for the terminal and the plugin only; no comment surface issues it, and the parity test that comes with the plugin marks it so (ADR 0019).
- **It opens the store as `serve` does**, made or rebuilt from the state branch when missing, unlike the terminal's other commands that change state, which never create one ([ADR 0044](0044-batch-leases-held-by-the-driver-and-one-command-log.md)): it is a driver, and a driver starts from the state branch.
- The registry gains **options**: a command lists the ones it takes, each with a value (`--as <name>` or `--as=<name>`); any other option is a mistake of the command line, as before.

### The owner
- **`--as <name>`**, when given: one path segment (`PathSafeId`), never `cellar`, the Cellar's ([ADR 0037](0037-attempt-worktrees-in-the-engine-and-driver-locks.md)).
- **Otherwise `session-<id>`**, from `CLAUDE_CODE_SESSION_ID`, the session the command runs in, in lower case. `foedrum brew` run again from the same session, also after `claude --resume <id>`, has the same owner: it takes its own lock again, expires its own lost attempts and drives on the batch its lease still names.
- **Neither** is a mistake of the command line (exit 2): a terminal outside Claude Code names its driver with `--as`.
- After `/clear`, or a resume that gives the session a new id, the owner is another one. The batch is then refused while the old owner's lease lives, at most one lease (5 minutes), then it is free. The plugin (#336) can pass `--as` when that matters; takeover (#335) is the way to take a batch at once.

### How it runs, and its exit codes
It reads the Brewery's files as `serve` does, takes the lock of its owner (a second `brew` under one owner is refused), opens the store as `serve` does (made, or rebuilt from the state branch, when missing), opens the driver with `takes` that batch alone, and ticks it every 5 seconds until the batch stops:

| Exit | When | It prints last |
|---|---|---|
| 0 | the batch is **on tap** and the driver let it go: every effect applied | its pull requests |
| 1 | it **failed**: the Brewery's files, the store, the state branch or GitHub; or it was stopped (Ctrl+C) | the reason, or the lane it left the batch in |
| 2 | the **command line** is wrong, or names no owner | one line |
| 3 | the batch is **Stuck** on anything but questions | its reason and options |
| 4 | the batch **needs input** | each question numbered, with its options, recommendation and why it blocks, then the `foedrum answer <batch> …` line that answers them in order |
| 5 | **refused**: another driver holds the batch (named, with when its lease ends), the issue's latest batch ended, the issue cannot be routed or ordered, or the owner's lock is held | why |
| 6 | the batch was **cancelled** | who cancelled it |

- **On needs input** the session asks the engineer, runs `foedrum answer`, and runs `foedrum brew` again ([ADR 0006](0006-no-mid-run-questions.md): the brewer never asks; [ADR 0019](0019-interactive-sessions-and-one-command-layer.md): the session asks right away). The numbers are the questions' ids: `answer` takes one answer per question in that order.
- **A Stuck batch keeps its lease** when `brew` exits ([ADR 0044](0044-batch-leases-held-by-the-driver-and-one-command-log.md)), so the Cellar does not take it while the engineer answers; its next `brew` renews it. Closing the driver lets the lock go; the lease lapses on its own one lease later.
- **A batch another driver holds** is refused at the start with its holder, and so is one lost while it brews (the driver's `batch_lost`), or never taken because another driver took it first. Takeover is #335.

### What it prints
Every line starts with `foedrum brew:` and has its control characters escaped, as `serve`'s ([ADR 0063](0063-foedrum-serve-its-configuration-and-wiring.md)): the order and the route when it makes them, one line when it starts (the batch and the owner), the driver's notices as `serve` words them (`formatNotice`), the batch's lane and what it does there each time that changes (`describeLane`, as `foedrum status` shows it), and the last line or lines of the table above.

### One wiring for both drivers
`serve`'s wiring moved into `wireDriver` (`src/cli/driver-wiring.ts`): under the lock the caller took, the store and the state branch, the attempt worktrees, GitHub through gh, the status comments and claim effects, the attempt plans, the check runner and the guards, and `openDriver` with the real runner. `runServe` and `runBrew` (`src/cli/brew.ts`) each take their own lock, give their own `takes`, and run their own loop; `serve` adds the intake. Both run on a `ServeShell`; `readServeSetup` reads the starting facts for either command. `foedrum brew` runs no intake: it orders and routes only its own issue.

### `foedrum status`
A batch whose live lease names a driver other than the Cellar shows it: `brewed interactively by <owner>`, after what the batch does.

## Consequences
- An engineer brews an order from a terminal or a Claude Code session without a Cellar, and beside one: the Cellar skips the batch while its lease lives.
- The plugin (#336) runs `foedrum brew` and reads its exit code; it needs no other contract.
- A `brew` that stops on Stuck leaves the Cellar out of that batch for up to one lease, also when the engineer never comes back. That is the wait of ADR 0044, with its deadline.
- The state branch is flushed by `brew`'s own ticks, as by `serve`'s.
- Not covered: takeover (#335), the plugin (#336), `/foedrum:resume` (#337) and resuming a running batch (#338).

## Alternatives considered
- **A fixed owner such as `session`:** two engineers on one machine, or two sessions of one, would share a lock, and the second would be refused or expire the first's leases.
- **The owner from `CLAUDECODE` or the process tree:** `CLAUDECODE` names no session, and a process id changes with every resume.
- **A random owner per run, kept in a file:** a file next to the store would have to say which session it belongs to, which is what the session id already says.
- **Order an ended issue again:** a closed pull request or a cancel is a person's decision, which `foedrum order` records.
- **Copy serve's wiring into brew:** two copies would drift; the guards and effects must be the same whichever driver runs a batch (ADR 0019).
- **Run the intake in brew:** it would order and claim other issues too, which is the Cellar's.
