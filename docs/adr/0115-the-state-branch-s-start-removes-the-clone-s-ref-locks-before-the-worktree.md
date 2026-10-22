# 0115. The state branch's start removes the clone's ref locks before the worktree, the signing check's among them

Date: 2026-10-22 · Status: Accepted · Amends [0111](0111-the-state-branch-s-ref-lock-and-head-lock-are-stale-under-the-writer-lock.md) (when the branch's ref lock is removed, and which ref locks are)

## Context
ADR 0111 has a start and a flush of the state branch remove a stale `index.lock`, `HEAD.lock` and `refs/heads/foedrum/state.lock` under the writer lock, with both git folders asked through the state worktree (`git rev-parse` in it). A start removed them after it opened the worktree, since before that there is nothing to ask. Two cases of the same kind were left (#320):

- **The worktree add.** When the state worktree does not exist yet (a first start, or one after it was deleted) and the remote branch does, the start creates it with `git worktree add -b foedrum/state …`, which moves the branch's ref. ADR 0111 names that add as one of the gits that write the ref, so a kill during it leaves exactly `refs/heads/foedrum/state.lock`; the next add fails with `cannot lock ref` before the removal runs, and every start fails the same way.
- **The signing check's ref.** Every start runs `git update-ref refs/foedrum/signing-check <sha>` and `update-ref -d` for its test commit (ADR 0024). A git killed there leaves `refs/foedrum/signing-check.lock` in the clone's common git folder, and every later start fails at that `update-ref`. ADR 0111's "Nothing else" left it out.

## Decision
- **The signing check's ref lock is stale under the writer lock too.** Only the signing check writes `refs/foedrum/signing-check`, always during a start, so under the writer lock, like the branch's ref, its lock was left by a git that no longer runs. A start and a flush remove `refs/foedrum/signing-check.lock` with the other three, and nothing else; ADR 0111's other lock files (`packed-refs.lock`, other refs' locks, `ORIG_HEAD.lock`) still stay.
- **The clone's two locks go before the worktree is opened.** Their folder is asked of the clone, `git rev-parse --path-format=absolute --git-common-dir` in it, once, so it needs no worktree; a start removes them before `openWorktree`, and `index.lock` and `HEAD.lock`, whose folder only the worktree can name, after it, still before the test commit. A flush removes all four before it writes.
- **Each removal line says the folder it was in:** `removed a stale refs/heads/foedrum/state.lock from the clone's common git folder: <path>` and the same for `refs/foedrum/signing-check.lock`; `index.lock` and `HEAD.lock` stay `… from the state worktree: <path>`.

## Consequences
- A Cellar killed while its start created the state worktree, or while its signing check moved the probe ref, starts again: the next start removes the lock, says so, and goes on.
- A start asks git for the common folder once more than before, in the clone; the worktree is asked only for its own git folder.
- ADR 0111's consequences hold as they are for the probe ref: a git that outlives its driver for one call fails its own update, and the next start retries.
- The unit tests of the shell cover both with the fake git: a start with no worktree and a stale branch ref lock, a start with a stale probe ref lock, both left alone while another writer holds the writer lock, and the files beside them untouched.

## Alternatives considered
- **Ask the common folder of the worktree after the add, and retry the add:** the add would fail first, so the removal would be decided by a failure, which ADR 0107 rejected for `index.lock`.
- **Name the probe ref under `refs/heads/foedrum/`:** its lock would sit beside the branch's, but a branch named there is visible to users and to the attempt branches' namespace (ADR 0029); the lock would still need removing.
