# 0092. `foedrum status` lists the task-tree branches the cleanup keeps

Date: 2026-10-20 · Status: Accepted, amended by [0101](0101-the-cleanup-keeps-the-attempt-branches-that-hold-a-rewound-task-tree.md) (a rewound task tree's branches, read in their attempt's clone) · Amends [0084](0084-a-batch-s-commits-end-in-a-pull-request-or-on-a-kept-branch.md) (nothing reminds anyone of a kept branch)

## Context
[ADR 0084](0084-a-batch-s-commits-end-in-a-pull-request-or-on-a-kept-branch.md) keeps the branch of an ended batch's task tree when no push recorded it (`Claims.unpushed`) and its tip is not the batch's start. Its consequences say nothing reminds anyone of such a branch beyond the cleanup's `kept branch` line, which `foedrum serve` prints once and which scrolls away. The branches pile up in the clone, and each holds work someone may want (#232).

## Decision
- **`foedrum status` lists them after the batches**, one line each: the batch, the branch, its commits past the batch's start (`start unknown` when the claims have none), and the line that drops it once the commits are taken, with the clone it runs in: `in <clone>: git branch -D <branch>`. Above them, `<n> kept branch(es): commits of ended batches that no push recorded (ADR 0084); take them, then drop the branch`. Nothing is added when nothing is kept, so a Brewery without such a branch sees what it saw before.
- **The claims decide, git only reads.** The pure `keptBranchLines` (`src/cli/kept-branches.ts`) takes `Claims.unpushed`, as `worktreeClaims` folds it, and each branch's reading: its tip and its count past the start, gone, or not read with the reason. It keeps what `planClean` keeps: a branch whose tip is the start is left out, as is one the clone no longer has. A branch git could not be asked about is listed with the reason (no clone for its repository, a git that failed), never left out, since the cleanup kept it.
- **The reading goes through the engine's git in the clone.** `readKeptBranches` (`src/cli/kept-branches-git.ts`) runs `git rev-parse --verify --quiet refs/heads/<branch>` and `git rev-list --count <start>..<tip>` through `runGit` (non-interactive, with its timeout and output limit) in the clone the attempt worktrees are added to, never in a worktree a brewer wrote. The clone is the one serve uses, found the same way from `foedrum.jsonc` and `.foedrum/local.jsonc` (`attemptClone`, `src/cli/serve-config.ts`): the user's clone for `source: local`, the managed `clone.git` in the work root otherwise. status reads git, and those files, only when an ended batch has such a branch.

## Consequences
- A kept branch shows up every time someone looks at the batches, with the line that ends it. It still stays until someone drops it; status does not drop it.
- `foedrum status` now runs git when there is a kept branch, so it can be slower then, and a clone that is gone or not a repository is named on its line instead of failing the command.
- A rewound task tree is still a commit, not a branch, and names nothing to keep (#255).

## Alternatives considered
- **`foedrum doctor`:** doctor checks the machine's tools and the isolation level before anything brews, and reads no event store. A kept branch belongs to a batch, and status is where batches are read, so the reminder sits next to the batch it is about.
- **Count with `git rev-list --count <tip> --not <base>`:** exact for a base that moved on, but needs the base's ref in the clone. The start is in the claims already, as ADR 0084 chose for the cleanup.
- **Drop the branch from status, or add a command for it:** status is read-only (ADR 0030), and taking the commits is a human's call; the line to run is enough.
