# 0259. A driver with neither `--as` nor a session is `terminal`

Date: 2026-10-30 · Status: Accepted · Amends [0123](0123-foedrum-brew-drives-one-batch-under-an-owner-of-its-own.md) (the owner when neither `--as` nor a session names one; the lock's refusal names `--as`) and [0124](0124-foedrum-takeover-hands-a-batch-to-another-driver-as-a-recorded-command.md) (takeover's owner without either)

## Context
`foedrum brew`, `foedrum mash` and `foedrum takeover` name the driver that holds a batch: `--as <name>`, else `session-<id>` from `CLAUDE_CODE_SESSION_ID` ([ADR 0123](0123-foedrum-brew-drives-one-batch-under-an-owner-of-its-own.md), [ADR 0124](0124-foedrum-takeover-hands-a-batch-to-another-driver-as-a-recorded-command.md)).
With neither, the command was a mistake of the command line (exit 2): "no Claude Code session names the driver (CLAUDE_CODE_SESSION_ID); give --as <name>".
One person at one terminal outside Claude Code, the common case for a first run, had to invent a name before anything happened (#654).

ADR 0123 turned down a fixed owner such as `session`, because two engineers on one machine, or two sessions of one, would share a lock.
A Claude Code session still has an owner of its own, from its id, so that reason now holds only for two terminals outside Claude Code on one Brewery's work root.

## Decision
- **With neither `--as` nor a Claude Code session, the owner is `terminal`** (`TERMINAL_OWNER`, `brewOwner` in `src/cli/driver-owner.ts`). An empty `CLAUDE_CODE_SESSION_ID` counts as no session.
- **One rule for the three commands.** `brew` and `mash` drive as `terminal`, and `takeover` hands the batch to `terminal`, so a terminal that takes a batch over is the driver a later `foedrum brew` from that terminal is.
- **A terminal is one owner across its windows and restarts**, as a session resumed by id is: `foedrum brew` run again takes its own lock again, expires its own lost attempts and drives on the batch its lease still names.
- **A second driver under `terminal` meets the owner's lock** while the first runs (exit 5, [ADR 0037](0037-attempt-worktrees-in-the-engine-and-driver-locks.md)). `brew` and `mash` now end that refusal with "or give --as <name> to run another driver beside it". The lock's own message (`DriverRunningError`) stays as it is, since the Cellar shares it.
- **`--as` stays** for two terminal drivers side by side, and wins over the session as before.
- **The refusal stays only for a session id that names no driver**: one that is not a path-safe name in lower case after `session-` (exit 2, naming `--as`).

## Consequences
- A first run from a terminal needs no name: `foedrum brew <issue>` drives.
- `foedrum status` shows such a batch as `brewed interactively by terminal`.
- Two people who share one work root from plain terminals share the owner `terminal`: the second `brew` is refused while the first runs, naming `--as`, and a `takeover` without `--as` by either hands the batch to the same owner. Each gives `--as` to stay apart.
- `--as terminal` names the same owner as no name at all, as `--as session-<id>` names a session's.

## Alternatives considered
- **Keep the refusal:** a first run asks for a name that tells Foedrum nothing it could not choose itself.
- **A name per machine or per user (`terminal-<user>`):** two terminals of one person still share it, and a lock that refuses the second is what one owner per person needs; the user name would also go into the leases and `foedrum status` for no gain.
- **A name per process or terminal window:** it changes with every run, so a restarted `brew` would not find its own leases ([ADR 0037](0037-attempt-worktrees-in-the-engine-and-driver-locks.md)), and the batch would wait a lease before the next run could drive it.
- **Keep takeover refused without a name:** `brewOwner` would become two rules, and a terminal that takes a batch over would have to name the owner its next `brew` drives under anyway.
