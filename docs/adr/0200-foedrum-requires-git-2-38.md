# 0200. Foedrum requires git 2.38

Date: 2026-10-26 · Status: Accepted · Amends [0109](0109-a-brewer-s-git-holds-no-push-credential.md) (doctor requires git 2.38.0, not 2.31.0) and [0198](0198-an-open-pull-request-is-merge-tree-checked-when-its-base-moves.md) (the base check runs on every git Foedrum runs on, and `foedrum serve` no longer reads git's version for it)

## Context
Foedrum required git 2.31, the first to read the `GIT_CONFIG_COUNT` pairs a brewer's forced configuration rests on ([ADR 0109](0109-a-brewer-s-git-holds-no-push-credential.md)).
The base check of open pull requests ([ADR 0198](0198-an-open-pull-request-is-merge-tree-checked-when-its-base-moves.md)) runs `git merge-tree --write-tree`, which came in git 2.38 (October 2022), so `foedrum serve` read git's version once at its start and, below 2.38 or when git named none, checked no pull request; `foedrum doctor` gave an advice line for it.
ADR 0198 left raising the required git as a follow-up, and [ADR 0164](0164-a-batch-merges-its-base-before-its-last-check.md) had kept away from `merge-tree --write-tree` for the same version.
#513 raises it: a check that runs on some machines and silently not on others is a gap in what an open pull request is told, and git 2.38 is four years old.
CI's git, read from its logs on 2026-10-25, is 2.55.0 on ubuntu-24.04, 2.56.0 on macos-26-arm64 and 2.56.0.windows.2 on windows-2025.

## Decision
- **`foedrum doctor` requires git 2.38.0 or later** (`MIN_GIT`, `src/cli/doctor.ts`): an older git is a required problem that names the version found and the one needed, `git <version> is too old`, with `install git 2.38.0 or later`. `foedrum serve`, which refuses on every required problem doctor finds (ADR 0063, ADR 0073), does not start with one. Git 2.38 also reads `GIT_CONFIG_COUNT`, so ADR 0109's reason holds.
- **The base check's own version gate goes.** `foedrum serve` no longer runs `git --version` at its start for it, and checks the open pull requests against their base on every pass whenever its shell can merge-tree; the advice line in doctor and the one line serve said below 2.38 go with it (`MERGE_TREE_GIT`, `baseCheckProblems`, `mergeTreeSupported`).

## Consequences
- A machine with git 2.31 to 2.37 that brewed before no longer does: doctor says to update git, and serve does not start.
- One fewer git call at serve's start, and no case in which the base check is off without a failure.
- A git that is replaced by an older one while serve runs fails the merge-tree each pass, reported, as any other failed merge-tree (ADR 0198); nothing is posted that no check saw.
- ADR 0164's merge of the base before the last check could now run without a worktree; that is a choice of its own, not made here.

## Alternatives considered
- **Keep 2.31 and the gate.** The base check stays off on an older git with one line at serve's start that is easy to miss.
- **Keep the gate as well as the requirement.** It would guard a case doctor already refuses before serve starts.
