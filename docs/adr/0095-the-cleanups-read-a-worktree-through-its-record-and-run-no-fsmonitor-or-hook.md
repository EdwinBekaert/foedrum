# 0095. The cleanups read a worktree through its record, and run no fsmonitor command or hook there

Date: 2026-10-20 · Status: Accepted · Amends [0074](0074-git-commit-grants-fixed-git-rules-and-done-needs-a-commit.md) (never git by discovery in the worktree, for the gits that read one, not only the commit count) and [0029](0029-attempt-worktrees-layout-claims-and-repair.md) (the status call of the attempt cleanup)

## Context
ADR 0074 counts a brewer's commits in the clone, "never in the worktree, whose `.git` file the brewer can write". A git run in a folder finds its repository through that file, reads the configuration of the git folder it names, and runs the command in its `core.fsmonitor` while it reads the index. So a `.git` file of `gitdir: ./x`, with `core.fsmonitor = <command>` in `x/config`, makes that git run the command, outside the attempt's isolation and with the environment of whoever ran git.

#263, from the review of #259 (ADR 0093), found such a git in `folderState` (`src/workspace/worktree-removal-git.ts`): `git status --porcelain`, run in the worktree. `folderState` turned out to be the session cleanup's (`npm run worktrees:clean`, which removes merged worktrees under `.claude/worktrees/`), not the attempt cleanup's. The attempt cleanup already read the state through the record and with `core.fsmonitor` off (`stateOf`, ADR 0029). Both share `worktree-removal-git.ts`, and both were short of the same thing. The integration test of #263 found two more gits that run a repository's fsmonitor command:

- `git worktree remove` runs a `git status` of its own in the worktree, with `GIT_DIR` at the worktree's `.git` file once it has checked that file points back at the record. That status, and the remove itself, read the repository's configuration.
- `git fetch` in the session cleanup's main checkout reads that checkout's index, and so runs its `core.fsmonitor` command. It doesn't always do this, which made the test fail only now and then.

## Decision
- **One status call** for both cleanups, `statusOf` (`src/workspace/worktree-removal-git.ts`): `git --git-dir=<record> --work-tree=<folder> status --porcelain --ignore-submodules=all`, run in the clone (the main checkout for the session cleanup). It runs with `core.fsmonitor=false` and `core.hooksPath` at the null device for the call (`noRepositoryCommands`, given through `GIT_CONFIG_COUNT` as `GitOptions.config`). git never discovers a repository from the folder, so the folder's `.git` file plays no part.
- **No submodule is looked into** (`--ignore-submodules=all`). For a gitlink, git status starts a git of its own in the submodule's folder, and that git finds its repository by discovery, through the submodule's `.git` file. The review of #265 showed that a brewer who commits a gitlink and then points `sub/.git` at a git folder of its own gets that folder's `filter.<x>.clean` run, with the folder's configuration. The fsmonitor and hooks settings the call passes are inherited, but they don't cover a filter. With the option, git compares no submodule content and starts no git there. A worktree with a submodule then reads by its other changes only, and `git worktree remove` refuses it ("working trees containing submodules cannot be moved or removed") after reading only its index. So the cleanup reports it as one it could not remove and keeps it.
- **The record comes from the clone, never from the `.git` file**: it is the folder under `<git common dir>/worktrees/` whose `gitdir` file names the folder git lists (`readRecords`, the records `git worktree list --porcelain` reads). The session cleanup reads them as it already did for pruning, and the attempt cleanup as ADR 0029 does.
- **No record, no git**: `folderState` gives `unchecked` for a folder whose record the clone doesn't have, and the cleanup keeps it as `kept worktree <folder>: no record under .git/worktrees/ points at it`, as it keeps a dirty one. Before, git ran in such a folder too. The attempt cleanup still keeps a folder whose `.git` file doesn't name its record (`foreign`, ADR 0029); it now goes through `statusOf` too, so its status also runs no hook.
- **`git worktree remove` gets the same configuration.** The status git starts in the worktree inherits it through the environment, so no fsmonitor command runs there either. git still checks the `.git` file against the record first, and refuses a file that names another git folder.
- **The session cleanup's `git fetch --prune` gets it too**, since it reads the main checkout's index.

### Every engine git call on an attempt worktree
None runs with the worktree as its working directory, now that both cleanups use `statusOf`:

| Call | Where it runs | What reads the worktree |
| --- | --- | --- |
| state of a worktree (`stateOf`, `src/workspace/attempt-worktrees-git.ts`) | the clone | `statusOf`, this ADR |
| `git worktree remove` (`removeWorktree`, `src/workspace/worktree-removal-git.ts`) | the clone | its own status in the worktree, with this ADR's configuration |
| `git worktree add` (`attach`, `src/workspace/attempt-worktrees-git.ts`) | the clone | its checkout writes the new folder and runs the clone's `post-checkout` hook: the clone's configuration and hooks, #200 |
| the commit count (`countCommits`, `src/workspace/attempt-commits-git.ts`) | the clone | nothing: refs only (ADR 0074) |
| the red proof's and the `testsUnchanged` guard's diffs (`readDiff`, `src/checks/step-commits.ts`) | the clone | nothing: commits only ([ADR 0078](0078-the-red-proof-reads-the-test-report-and-testsunchanged-compares-lines.md)) |
| the push effect (`src/workspace/branch-push-git.ts`) | the clone, and a git directory of its own for the base | nothing ([ADR 0090](0090-the-push-fetches-the-base-in-a-git-directory-of-its-own.md)) |
| the worktree manager's fetch (`fetchOnce`) | the clone | nothing, but in a `local` clone it reads the clone's index and configuration, `core.fsmonitor` included: #200 |

The state branch's worktree is Foedrum's own, which no brewer writes (ADR 0024). A check step's commands run in the attempt's worktree as the repository's commands, not as the engine's git (ADR 0069, #190).

## Consequences
- `test/integration/worktrees-clean.test.ts` shows it with real git and a node script as the fsmonitor command, so it runs on Windows too. The command writes down where git ran it, and the assertion prints that. One test plants a git folder inside a worktree, with an index and `core.fsmonitor`, and points the worktree's `.git` file at it: the command never runs, the clean worktree goes and the dirty one stays. Another sets `core.fsmonitor` in the main checkout's own configuration: removing a clean worktree runs it nowhere. A third commits a gitlink, points the submodule's `.git` file at a git folder with a clean filter, and changes a file there: the filter never runs. All three failed before their change: the first in `folderState`'s status, the second in `git worktree remove` and its status (and now and then in the fetch), the third in the status's git in the submodule.
- A developer's own `core.fsmonitor` (Git's built-in daemon, say) no longer speeds up the cleanup's status. The cleanup reads a few worktrees once per session, so this costs little.
- A folder under `.claude/worktrees/` that git lists but whose record is gone is kept and reported instead of read. It is removed once git no longer lists it, or by hand.
- What #200 names stays open: the clone's configuration and hooks still take part in the gits that run in the clone, `worktree add` and the fetch among them. A brewer that writes the clone's `config` reaches those, and this ADR only takes `core.fsmonitor` and hooks out of the gits that read a worktree's index.

## Alternatives considered
- **Read the `.git` file and refuse a folder whose file doesn't name its record**, then run git in the folder as before. The attempt cleanup does this check, but between the check and the git a brewer can still write the file. Only `--git-dir` takes the file out of git's hands.
- **Only `core.fsmonitor=false` for the status, with git still finding the repository from the folder.** The named git folder's configuration would still apply: its `core.hooksPath`, `include.path`, and whatever a later git release reads there.
- **`GIT_CEILING_DIRECTORIES` or `safe.directory`.** Neither stops git from following a `.git` file in the folder it starts in.
- **Leave `git worktree remove` and the fetch to #200.** They are the gits the integration test catches running the planted command, and the same one line of configuration stops them.
