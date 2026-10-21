# 0111. The state branch's ref lock and HEAD.lock are stale under the writer lock too

Date: 2026-10-21 · Status: Accepted · Amends [0107](0107-one-writer-of-the-state-worktree-at-a-time-and-its-stale-index-lock.md) (which lock files a start and a flush remove)

## Context
ADR 0107 made a start and a flush of the state branch hold the state worktree's writer lock, and from that concluded that an `index.lock` found in the worktree's git folder is stale at once. A `git commit` also takes two more locks: before it moves the branch it creates `<ref>.lock` beside the ref, and, since it moves the branch through `HEAD`, `HEAD.lock` for HEAD's reflog. git renames or deletes them when it is done, and removes them when it exits or is stopped by a signal it can catch; a git killed outright (SIGKILL, a Job Object closed on Windows, a kill at its deadline) leaves them behind (`lockfile.h` in git's source). The branch's ref, `refs/heads/foedrum/state`, lives in the clone's common git folder, shared by all its worktrees, while `HEAD` is the state worktree's own ([git-worktree](https://git-scm.com/docs/git-worktree), DETAILS and REFS; [gitrepository-layout](https://git-scm.com/docs/gitrepository-layout), `refs` and `worktrees`).

A ref lock left that way stops the state branch for good (#306): the start's signing check passes, since it updates only `refs/foedrum/signing-check`, and every flush's commit then fails with `cannot lock ref`, which the flush returns as `failed` and the supervisor retries on every tick. The events stay unpushed.

ADR 0107's reason covers the worktree's index, which only gits in the worktree write. The ref is in the clone, which other gits of Foedrum use too, so it needs a reason of its own.

## Decision
- **Every git of Foedrum that writes the state branch's ref runs under the writer lock.** Only the state branch's shell (`src/engine/state-branch-git.ts`) moves `refs/heads/<branch>`: the worktree's commits, merges and resets, and the `worktree add` that creates it, all during a start or a flush. The clone's fetches write only tracking refs (`refs/remotes/…`), and no attempt branch can be named below `foedrum/state` (ADR 0029). So while a start or a flush holds the writer lock, `refs/heads/<branch>.lock` in the clone's common git folder, like `HEAD.lock` in the worktree's git folder, was left by a git that no longer runs.
- **A start and a flush remove those two files with `index.lock`, and only them.** Their paths come from git: the worktree's git folder from `git rev-parse --absolute-git-dir`, the common one from `git rev-parse --path-format=absolute --git-common-dir`, both asked once. Each is removed through `removeTree` (`removeStaleLock` in `src/platform/index-lock.ts`, the helper `index.lock` uses) at the same moments as `index.lock`, and each removal says so in one line: `removed a stale HEAD.lock from the state worktree: <path>`, `removed a stale refs/heads/foedrum/state.lock from the state worktree: <path>`.
- **Nothing else.** Other lock files a killed git can leave (`packed-refs.lock`, `ORIG_HEAD.lock`, other refs' locks) stay. A start or a flush that meets one fails as before and says which file, so a new case is seen before it is handled.

## Consequences
- A Cellar killed while a flush's commit moved the branch starts again and flushes: its start removes the locks, says so, and goes on.
- A git outlives the driver that started it for at most one call (ADR 0107's consequence). Its ref lock removed while it runs makes its own ref update fail, or the next flush's commit fail once if it finishes after the removal; either way the next tick retries, and the commit's contents come from the store.
- The clone is the user's own Brewery checkout, and a git outside Foedrum that moves `refs/heads/foedrum/state` there (a user's own command) is not under the writer lock; its ref lock can be removed under it. Branches under `foedrum/` are Foedrum's namespace in a local clone (ADR 0012), so such a command is a mistake already, and the push to the remote still fails rather than overwrite a branch that moved (ADR 0024).
- The unit tests of the shell cover the removal with a fake git that answers `cannot lock ref` while such a lock is in a test folder, the files beside them left alone, and a held writer lock that leaves them untouched.

## Alternatives considered
- **Remove every `*.lock` in both git folders:** also removes locks of gits that do not run under the writer lock (a fetch's tracking refs, another worktree's files in the common folder), the very guess ADR 0107 avoided.
- **Remove the lock only when a commit fails with `cannot lock ref`, and retry:** the same removal, decided later; ADR 0107 rejected it for `index.lock` for the same reason.
- **Ask git for each path with `--git-path`:** git's recommended lookup, but one call per path; the two folders, asked once, give the same paths for the files backend, the only one whose locks are files at those places.
