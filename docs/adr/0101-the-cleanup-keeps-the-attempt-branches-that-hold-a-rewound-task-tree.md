# 0101. The cleanup keeps the attempt branches that hold a rewound task tree

Date: 2026-10-21 · Status: Accepted · Amends [0084](0084-a-batch-s-commits-end-in-a-pull-request-or-on-a-kept-branch.md) (what the claims name for a rewound task tree) and [0092](0092-foedrum-status-lists-the-task-tree-branches-the-cleanup-keeps.md) (which clone `foedrum status` reads such a branch in)

## Context
[ADR 0084](0084-a-batch-s-commits-end-in-a-pull-request-or-on-a-kept-branch.md) keeps the branch of an ended batch's task tree that no push recorded (`Claims.unpushed`). It names a branch only when the task tree is an attempt's branch: a rewound task tree ([ADR 0066](0066-the-task-tree-continues-from-the-latest-succeeded-attempt.md)) is a commit, not a branch, and ADR 0084 left that gap "for when rewinds reach the clone". [ADR 0092](0092-foedrum-status-lists-the-task-tree-branches-the-cleanup-keeps.md) said the same.

Rewinds do reach the clone. `fold.ts` records `{ kind: 'rewound', shas }` on `batch.rewound`, `taskTreeStart` returns the rewind's commit for the batch's repository, and the driver passes it to `manager.create`, which fetches, resolves it in the clone (`rev-parse --verify <sha>^{commit}`) and makes the next attempt's worktree there with `git worktree add -b <branch> <path> <sha>`. So a batch rewound and then cancelled before another attempt succeeded has its task tree only on attempt branches, and the cleanup deleted them all, leaving the commit dangling (#255).

Which branch holds the commit is a question for git. The pure plan answers from the state alone ([ADR 0084](0084-a-batch-s-commits-end-in-a-pull-request-or-on-a-kept-branch.md) chose the start commit over asking git for the same reason).

## Decision
- **For an ended batch whose task tree is a rewind, and whose ledger has no push from the rewind's commit, `Claims.unpushed` names the attempt branches that hold that commit**, each with the batch's start, and `planClean` keeps those whose tip is not the start with ADR 0084's line. Its worktrees still go.
  - When an attempt's worktree was made at the commit (the next attempt after the rewind, or an earlier one that started there), the branch of the last such attempt in that repository holds it, and only that one is named.
  - When none was (a rewind to the tip of a step that an action step came after, to the work of a failed attempt, or a cancel before the next attempt got its worktree), every attempt branch of the batch in that repository is named: any of them may hold the commit, and the state cannot tell which.
  - A rewind to the batch's start (the commit of its first attempt that succeeded, or of its first attempt when none did) holds nothing past it and names nothing. So does a rewind of a repository no attempt of the batch wrote in; a rewind of several repositories (a Brewery order) goes on to the next.
- **Branches are built from the attempt** (`attemptBranch`), never taken from the recorded `worktree.branch` ([ADR 0037](0037-attempt-worktrees-in-the-engine-and-driver-locks.md)).
- **`foedrum status` reads such a branch in the clone of the repository its attempt wrote in**: the attempt's recorded `worktree.repo`, found by the branch's step and attempt. A branch that names no attempt the batch recorded is listed as not read, with ADR 0092's reason, and no git runs.

## Consequences
- A batch's commits end in a pull request or on a branch that stays, also after a rewind, as ADR 0084 intends.
- A rewind to a commit no worktree was made at may keep several branches of one batch, each until someone deletes it; `foedrum status` lists them all. Rewinds start from a Stuck batch a human looks at, so this is rare, and a branch too many is cheaper than lost commits.
- "The last attempt made at the commit" follows the order of the batch's steps, not of the attempts in time. Any branch made at the commit holds it, so the choice only decides which other commits stay with it.

## Alternatives considered
- **Name only the last attempt that succeeded, in step order, as the task tree before the rewind:** one branch, but it need not hold the commit: a rewind to a failed attempt's work, or a recipe that loops back to an earlier step, whose old success hides the later commits (the order ADR 0066 rejects). The review of #288 found both.
- **Keep the task tree from before the rewind in the fold:** exact for a rewind to that tree's tip, but not for a rewind to a failed attempt's work, and it adds state to every batch for a rare case.
- **Ask git which branches contain the commit (`git branch --contains`):** exact, but a git call per rewound batch in the pure plan's facts, as ADR 0084 declined for the start.
- **Keep every attempt branch of a rewound batch:** simpler, but keeps the branches of failed attempts too when an attempt was made at the commit and already holds it.
