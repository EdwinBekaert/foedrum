# 0389. Nothing in `.foedrum/tmp` is kept, and the worktree cleanup clears it

Date: 2026-11-13 · Status: Accepted · Amends [0245](0245-brew-audit-a-read-only-audit-of-the-code-at-every-last-call.md) (the audits move to `<main>/.foedrum/audits/`) and [0383](0383-rack-archives-finished-batches-and-deletes-old-archive-folders-and-temporary-files.md) (rack's delete of temporary files never enters a folder that holds a `.git` entry)

## Context
A checkout's `.foedrum/tmp/` holds what sessions, reviews and tests leave there, and nothing cleared the main checkout's (#828).
It also held the one thing meant to last, the audits of [ADR 0245](0245-brew-audit-a-read-only-audit-of-the-code-at-every-last-call.md), so no rule could say that everything in it may go.
Rack's `deleteTemporary` ([ADR 0383](0383-rack-archives-finished-batches-and-deletes-old-archive-folders-and-temporary-files.md)) deletes old files there by age, also inside a worktree or a `/brew-review` scratch clone, which leaves a half-deleted repository behind.
`.claude/worktrees/` held 14 folders on 2026-11-13 that git listed as no worktree and that held no file.
The maintainer decided on 2026-11-13.

## Decision
### The rule for `.foedrum/tmp`
Nothing in it is meant to be kept: everything there belongs to a session, review or test that is running or once ran.
Files older than two days are deleted, and a folder that contains a `.git` entry (a file or a folder) is never deleted by age: whatever made it removes it.
A bare repository, which has no `.git` entry, is deleted by age like any files: the ones there, such as the remotes of `npm run demo` and the tasting comparison, belong to a finished run, and the next run empties and rebuilds its folder, so nothing is lost.
Foedrum's development worktrees go only in `.claude/worktrees/`.

### The audits move
`/brew-audit` keeps its reports and findings in `<main>/.foedrum/audits/<sha>/`, git-ignored by `.foedrum/*` as before, instead of `<main>/.foedrum/tmp/audits/<sha>/`.
The existing audit folders are moved by hand after the merge; no code reads the old place.

### One delete of old files
`deleteOldFiles` and its `TemporaryFilesIo` seam move from `src/engine/rack.ts` to `src/workspace/old-files.ts`, which rack and the worktree cleanup both import.
Before it enters a folder, the walk reads its entries; when one is named `.git`, it neither goes in nor deletes the folder, and the folder does not count as left.
That holds for rack too.

### The worktree cleanup clears the main checkout's `.foedrum/tmp`
`npm run worktrees:clean` (`scripts/worktrees-clean.ts`) deletes the files in the main checkout's `.foedrum/tmp/` older than two days through that delete, and prints one line with how many went and how many were left.
It does so before the fetch, so a failed fetch or fact query still clears it, and it never fails the session.

### Leftover folders in `.claude/worktrees/`
The cleanup removes a folder directly under `.claude/worktrees/` that git does not list as a worktree and that holds no file, only empty folders, and says so.
A folder that holds any file, a `.git` among them, is kept with a line that says why.
The core (`scripts/worktrees-clean/core.ts`) decides from a fact per folder the shell gathers: whether git lists it, and whether it holds a file ([ADR 0021](0021-unit-tests-spawn-no-processes.md)).
The shell removes it from the bottom up with `rmdir`, never a recursive delete, so a file that arrives meanwhile stops it.

## Consequences
A file left in the main checkout's `.foedrum/tmp/` lasts about two days past its last change, until the next session starts there.
A scratch clone or a worktree there outlives the rule until whatever made it removes it.
A Brewery needs no migration: Foedrum has no release yet, and a Brewery's own files do not change.

## Alternatives considered
- Keeping the audits under `.foedrum/tmp/` with an exception for `audits/`: the rule would no longer be one line.
- A check or report for worktrees outside `.claude/worktrees/`: the rule in `CLAUDE.md` is enough for now, with no failure behind a check.
- Removing a leftover folder that holds a `.git` but no worktree record: it may be someone's clone; it stays.
