# 0351. The clone's packed-refs.lock is stale under the writer lock, unless a local target shares the clone

Date: 2026-11-08 · Status: Accepted · Amends [0111](0111-the-state-branch-s-ref-lock-and-head-lock-are-stale-under-the-writer-lock.md) and [0115](0115-no-git-of-the-state-branch-outlives-the-writer-lock-and-its-ref-locks-go-before-the-worktree.md) (which lock files a start and a flush remove: `packed-refs.lock` too, unless a local target shares the clone)

## Context
ADR 0111 has a start and a flush of the state branch remove the lock files a killed git leaves where only the state branch's gits write, under the state worktree's writer lock (ADR 0107), and ADR 0115 added the signing check's ref lock. Every other lock file, `packed-refs.lock` among them, stayed "so a new case is seen before it is handled".

This is that case (#941). On 2026-11-07, Windows CI failed on a docs-only commit: the demo kills the Cellar mid-attempt and starts it again, and the restart found the Brewery's `.git/packed-refs.lock`: `foedrum serve: git update-ref failed: error: Unable to create '…/demo/brewery/.git/packed-refs.lock': File exists.` Every later command of the demo refused the same way. Among 40 failed CI runs since 2026-10-26, it is the only one with that message.

git takes `packed-refs.lock` in a ref's delete, whether or not the ref is packed, and not when it creates or moves one. Run with git 2.56 for Windows: with the file in place, `update-ref -d` of a loose ref fails with that message, and `update-ref` of a new ref succeeds. Every start deletes the signing check's ref (`update-ref -d refs/foedrum/signing-check`, ADR 0024), so a leftover `packed-refs.lock` stops every start for good.

These gits of Foedrum run in the Brewery's clone:
- **Under the writer lock:** the state branch's own (`src/engine/state-branch-git.ts`). Of these, only the signing check's delete takes `packed-refs.lock`. The start's fetch writes a tracking ref without `--prune`, and the worktree add, commits, resets and push create or move refs. None of them starts a gc (ADR 0115).
- **Outside it, only when the Brewery is also a local target repository whose clone is the Brewery's checkout** (ADR 0106 names that case): the attempt worktrees' `fetch --prune` (`src/workspace/attempt-worktrees-git.ts`), whose prune deletes tracking refs, and the cleanup's `update-ref -d` of an attempt branch. They run in the same `foedrum serve` process as the flushes, on every tick and cleanup.
- **Elsewhere:** the branch push, the merge trees and the base fetch run in git directories of Foedrum's own (`--git-dir`, ADR 0198), whose `packed-refs` are their own.

So ADR 0111's reason holds for `packed-refs.lock` only while no local target's attempt worktrees use the Brewery's clone.

## Decision
- **A start and a flush remove the clone's `packed-refs.lock` with the other locks.** It is in the clone's common git folder beside the two ref locks of ADR 0115, so it goes through the same helper (`removeStaleLock`, through `removeTree`), at the same moments: before a start opens the worktree, and before a flush writes. The removal says so in one line: `removed a stale packed-refs.lock from the clone's common git folder: <path>`.
- **Not when a local target shares the clone.** `foedrum serve` and `foedrum brew` pass the state branch `sharedWithTarget` when a repository with `source: local` names the Brewery's checkout as its clone (paths compared as the platform's file system does, `samePath`). The state branch then leaves `packed-refs.lock` alone, since a live fetch of the attempt worktrees can hold it. A start that meets it fails as before, and the failure now says what to do: the file was left by a git that was stopped, and the user deletes it once no git runs in the checkout.
- **Nothing else.** `ORIG_HEAD.lock`, other refs' locks and the clone's other lock files still stay, as ADR 0111 and ADR 0115 have it.

## Consequences
- A Cellar killed while one of its gits held `packed-refs.lock` starts again: its start removes the lock, says so, and goes on. The demo plants the file after its kill, and its test reads the removal line in the restart.
- **A user's own git in the clone** is not under the writer lock: `git fetch --prune`, `git branch -d`, a gc's `pack-refs`. If a start or a flush removes its `packed-refs.lock` while it runs, that git later renames the path `packed-refs.lock` over `packed-refs`. When nothing took the lock again in between, the rename fails and its command fails, with `packed-refs` as it was. When another git did, such as the signing check's delete right after the removal, the rename can put that git's unfinished file in place as `packed-refs`, and the refs packed there are lost; a branch's reflog still names its commits. This follows from git's lock file design and was not run. It takes a user's git and a start or a flush in the same milliseconds. As for the ref lock in ADR 0111, the clone is the user's Brewery checkout and the risk is theirs to avoid: run no git there while Foedrum starts.
- **A Brewery that is its own local target** keeps today's refusal of a leftover `packed-refs.lock`, now with what to do. Its attempt worktrees' `fetch --prune` and branch deletes run outside the writer lock, so a removal could break a live one in the way just described, with Foedrum's own gits on both sides and on every tick.
- The unit tests of the shell cover the removal at a start and at a flush with the fake git, which refuses a ref's delete while `packed-refs.lock` is in its common folder, and the refusal with what to do when the clone is shared. The serve shell's tests cover both through `serveShell`, the shared clone written another way.

## Migration
None. A Brewery's files do not change, and a working Brewery needs nothing new.

## Alternatives considered
- **Run the attempt worktrees' ref deletes in the Brewery's clone under the writer lock** (`fetch --prune` and the branch cleanup when their clone is the Brewery's): the writer lock is held by the state branch inside `openStateBranch`, for one start or flush at a time, so the attempt worktrees would need it handed to them across modules. A fetch holds it for as long as its deadline, so flushes wait or fail behind every fetch. That costs more than the case it would cover: a Brewery that is its own local target, with a leftover lock that the refusal now explains.
- **Remove `packed-refs.lock` only when it is older than a minute, as the attempt worktrees do for `index.lock`:** a killed Cellar's start would wait or fail for that minute, which ADR 0107 rejected, and the age still guesses at whether a git of the attempt worktrees runs.
- **Remove it only when the signing check's delete fails, and retry:** the same removal, decided later; ADR 0107 rejected that for `index.lock`.
