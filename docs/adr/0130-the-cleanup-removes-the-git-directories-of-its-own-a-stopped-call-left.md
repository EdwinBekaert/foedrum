# 0130. The cleanup removes the git directories of its own a stopped call left

Date: 2026-10-22 · Status: Accepted · Amends [0029](0029-attempt-worktrees-layout-claims-and-repair.md) (the cleanup also looks in git-dirs/, beside the attempts root), [0090](0090-the-push-fetches-the-base-in-a-git-directory-of-its-own.md) and [0096](0096-the-engine-s-git-reaches-the-remote-outside-the-clone-s-configuration.md) (a killed call's git directory no longer stays for good)

## Context
Every push, `ls-remote` and fetch the engine makes for a clone runs in a git directory of its own, `<work root>/<owner>.<name>/git-dirs/<uuid>.git` (`withOwnGitDir`, `src/workspace/clone-git.ts`, ADR 0090, ADR 0096), and removes it in a `finally` block. When serve is killed mid-call (a SIGKILL, a closed terminal, a power cut), the `finally` never runs and the directory stays. ADR 0090 and ADR 0096 accepted that, since each one is a few kilobytes: its objects are the clone's. But nothing ever removed them, so they piled up over months of kills (#256).

A directory a running call still uses must never go: the call would fail, and a driver of the same work root may be running one while another driver cleans. Nothing records which calls run, and a directory's name is a random UUID, so the only fact left is its age.

The longest a call keeps its directory is the worktree manager's fetch (`fetchIntoClone`): after `init`, a `for-each-ref`, an `update-ref`, a `config --get-regexp`, two `config` calls, the fetch itself with its 300 s transfer timeout, another `for-each-ref` and two `update-ref`s, each local call within git's default 60 s: about 13 minutes at most. The push's base fetch and push (300 s each) and its `ls-remote` (60 s) keep it for less. The runner kills each call at its deadline (ADR 0035), so no call outlives these.

## Decision
- **A floor of one hour** (`OWN_GIT_DIR_FLOOR_MS`, `src/workspace/attempt-worktrees.ts`): more than four times the longest a call can keep its directory, so a slow machine, a removal that retries on Windows, or a timeout raised later still stays under it.
- **The age is the directory's last change** (`mtime`, from `lstat`). A directory changes no earlier than it was made, so that age is never more than its true one: a directory that looks older than the floor is.
- **Only `<uuid>.git` directories older than the floor go** (`planOwnGitDirs`, pure, ADR 0021): a name `randomUUID` gives, in lower case, with `.git`, that is a directory and not a file or a link. Everything else in `git-dirs/` stays, whatever its name or age: a file, a link, a folder of another name, one of `id`'s names in a test. A time ahead of the clock counts as young.
- **When**: every cleanup of the worktree manager (`AttemptWorktrees.clean`), so at a driver's start (crash repair, where a killed serve's directories are found) and each time a batch ends (ADR 0029, ADR 0037). Each directory goes through `removeTree`, which retries while Windows holds a file; each removed one is a line of the report (`removed git directory <name>: a stopped call left it`), and one it could not read or remove, or a root it could not read, a failed line, after which the other directories and the cleanup of the worktrees go on. Only a candidate (a directory of that name) is read with `lstat`; one gone between the listing and its `lstat`, which a running call's own removal does, or still going on Windows, whose delete-pending entry fails with `EPERM`, is skipped without a line.
- The `base/` folder an earlier version used (ADR 0096) is not looked at.

## Consequences
- A killed call's git directory goes at the first cleanup an hour after it was made; until then it stays, as before.
- A machine that sleeps for over an hour in the middle of a call can wake to find its directory removed by another driver's cleanup: the call then fails, and is tried again as any failed fetch or push is (the effect's next pass, the next attempt's fetch).
- `test/unit/own-git-dirs.test.ts` covers the plan, and `test/unit/attempt-worktrees-clean.test.ts` the shell, with directories in a test folder whose times are set.

## Alternatives considered
- **A lock or a pid file per directory.** It says which calls run, but a killed call leaves it too, a pid can be reused, and it is one more file per call for a few kilobytes of litter.
- **Remove every directory at a driver's start.** Another driver of the same work root may be in a call.
- **One lasting git directory per repository.** ADR 0090 rejected it: shared refs and locks, and what is written there stays.
- **Remove the root's whole contents past the floor.** It would take whatever a user or a later version keeps there; the cleanup removes only what Foedrum names.
