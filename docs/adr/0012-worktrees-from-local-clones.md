# 0012. Worktrees from local clones

Date: 2026-10-13 · Status: Accepted

## Context
Enterprise repositories can be very large; cloning them per batch, or even once per tool, costs minutes and gigabytes. Developers usually already have the repositories cloned locally. Each attempt still needs an isolated working tree.

## Decision
- Every attempt works in its own **git worktree**. Foedrum never clones a repository per batch.
- Per repository, `source` decides where worktrees come from:
  - **`local`** (default): the user's existing clone. Foedrum creates branches only in its own namespace (`foedrum/<batch>/…`), places worktrees in the work root, fetches before branching, and never touches the branch the user has checked out.
  - **`managed`**: one bare **partial clone** (`--filter=blob:none`) per repository, created once in the work root, optionally borrowing objects from a local clone (`--reference`). For repositories the user does not have locally, CI, or dedicated machines.
- Worktrees and managed clones live in a **work root outside the Brewery checkout** (default `~/.foedrum/<brewery>/`, configurable, kept short on Windows). Claude Code loads instruction files (`CLAUDE.md`) from the working directory and every parent directory; worktrees nested inside the Brewery would inherit any instruction file placed there. Outside it, a brewer only sees the target repository's own instruction files.
- Foedrum generates no instruction file for the Brewery itself.
- Foedrum cleans up its worktrees and branches when a batch ends, and repairs stale worktree records and git lock files after crashes.

## Consequences
- Starting a batch takes seconds even for huge repositories.
- With `local`, Foedrum shares the user's object store and configuration (hooks, remotes); its branch namespace and worktree location keep it out of the user's way.
- Two Foedrum attempts never share a worktree; the user's own checkout is never modified.

## Alternatives considered
- **Full clone per batch:** clean isolation, unacceptable cost for large repositories.
- **Managed clones only:** independent of the user's setup, but duplicates large repositories on disk.
- **Working directly in the user's checkout:** no isolation; collides with the user's own work.
