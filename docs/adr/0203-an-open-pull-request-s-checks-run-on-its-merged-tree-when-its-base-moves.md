# 0203. An open pull request's checks run on its merged tree when its base moves

Date: 2026-10-26 · Status: Accepted · Amends [0198](0198-an-open-pull-request-is-merge-tree-checked-when-its-base-moves.md) (a clean merge-tree is recorded once the checks on the merged tree have run, with the failing reading when one fails, and a failure is posted and shown as a conflict is), [0069](0069-check-steps-run-the-repositorys-commands-in-an-attempt-of-their-own.md) (the check runner also reads a tree outside a check step's attempt) and [0130](0130-the-cleanup-removes-the-git-directories-of-its-own-a-stopped-call-left.md) (the cleanup also removes the merged trees a stopped run left)

## Context
Since [ADR 0198](0198-an-open-pull-request-is-merge-tree-checked-when-its-base-moves.md) each intake pass merge-trees the Brewery's open pull requests against their base's tip once it moved, and posts a conflict.
A merge that is clean but no longer builds or passes is found by nobody: GitHub does not run a pull request's checks again when its base moves.
#271's own example: #266 and #269 each merged cleanly into main, and together they failed the typecheck.
#271 was settled with the maintainer on 2026-10-25: Foedrum runs the repository's checks on the merged tree "in an attempt of their own (ADR 0069), one at a time per repository", says a failure on the pull request and in the status comment, and the batch stays On tap; the repair is a later issue's.

Four facts shaped it.
The intake pass has a deadline of half a batch lease (ADR 0068), and a test suite can take many minutes.
`git merge-tree --write-tree` gives a tree object, not files, and every git Foedrum runs on has it ([ADR 0200](0200-foedrum-requires-git-2-38.md)).
A batch On tap has run every step of its recipe: a step attempt of its own would need a step the recipe does not have, and a way back from On tap, which the repair is to settle.
And a check's command runs code a brewer may have written, which is why it runs in the check sandbox ([ADR 0076](0076-check-steps-run-in-an-os-sandbox-with-no-network.md)) after the repository's setup ([ADR 0140](0140-a-repository-s-setup-runs-before-a-check-step-s-checks-with-the-network.md)).

## Decision

### The pass finds a run due; a run of its own reads it
- **A clean merge-tree is not recorded by the pass when there are checks to run** (`checkBases`, `src/engine/base-check.ts`): the pass hands the pull request, its head and the tip to the Cellar's merged-check run (`BaseCheckRepository.checks`), and goes on. A conflict, a moved bottle branch, and a clean merge-tree of a batch with no checks to run are recorded by the pass as before.
- **Which checks**: those of the batch's recipe's check step that merges the base before it runs (`Recipe.mergesBase`, [ADR 0164](0164-a-batch-merges-its-base-before-its-last-check.md)), Nip's `green`: the checks the pull request opened on, named checks through the repository's `checks` in `foedrum.jsonc` as for the step, a literal command as it is. A recipe with no such step, or one whose checks are all skipped, has none to run.
- **The merged-check run** (`createMergedChecks`, `src/engine/merged-checks.ts`) runs beside the ticks and the intake pass in `foedrum serve`, never awaited by a tick, as the pass is (ADR 0068), and `serve` awaits the run underway when it stops, which a stop ends at once (below).
  - **One at a time in the Cellar**, so one at a time per repository: one Cellar per work root (its driver lock, [ADR 0037](0037-attempt-worktrees-in-the-engine-and-driver-locks.md)), and one run in it. A test suite on every core beside the brewers' attempts is load enough; two at once would slow both.
  - **A queue of the latest due tip per pull request**, in the order they came: a pull request whose base moved again before its run started is run once, at the newest tip; one whose run is underway is queued again at the new tip.
  - **Just before a run**, the log is read again: a batch no longer On tap, a pull request with a recorded end, or a check already recorded at that tip drops the run.
  - **Nothing is recorded until the run ends.** A kill of `serve` (Ctrl+C, a SIGKILL, a power cut) during a run leaves no record, so the next pass finds the tip moved since the pull request's last check and hands the run on again: no run is lost, and none is recorded twice. A stop ends the run's processes through its abort signal, and a run that read a `stopped` reading records nothing either.
  - **No lease and no ledger entry for the run**: no other driver runs it (only `serve` has an intake), and it has no external side effect: its record is an event, and the comment it calls for goes through the ledger (below).
- **Why not an attempt in the batch's log.** ADR 0069's "attempt of its own" is a worktree of its own, never an earlier attempt's, the check runner, and a deadline; the run has all three without being a step attempt (Alternatives).

### The tree it runs on
- **A folder of the merged tree's files, made in a git directory of Foedrum's own** (`openMergedTree`, `src/workspace/merge-tree-git.ts`): within one `withOwnGitDir` call ([ADR 0090](0090-the-push-fetches-the-base-in-a-git-directory-of-its-own.md)), the run merge-trees head and tip again (`--write-tree`, whose first output is the merged tree's id), then `git --git-dir=<it> --work-tree=<folder> read-tree -u --reset <tree>` writes the files into `<work root>/<owner>.<name>/git-dirs/<uuid>.tree`, beside its `<uuid>.git`. No hook and no configuration of the clone's takes part, as in the merge-tree; in a blobless clone the blobs the files need come from the URL Foedrum names. Both go when the run ends, also when it fails.
- **No worktree of the clone and no commit**: the folder holds the files and no `.git`, and the check gets `GIT_CEILING_DIRECTORIES` at the folder's parent, so a git command in a check finds no repository, rather than the git directory beside it. A check that reads the history fails there; its repository's checks read the same tree in green, where they have it.
- **ADR 0130's cleanup also removes a `<uuid>.tree` folder** older than its floor of one hour, which a killed run leaves. A run lasts at most the step's deadline (30 minutes for Nip's `green`) and the checkout's 5 minutes; a deadline of a recipe's own over 55 minutes is cut to 55 for the run, so the floor holds.

### How it runs: as a check step's attempt does
- **Through the check runner's own path** (`checkTree`, `src/checks/check-runner.ts`, which the check step's attempt now also runs through): the repository's setup first, with the network (ADR 0140), then each check in order through the check sandbox (ADR 0076), the first that does not pass ending the run; the brewers' minimal environment; the time left until 10 seconds before the run's deadline as each command's timeout, as ADR 0069 says; the readings and their tails cut and filtered for secrets as a check step's are.
- **Its deadline** is the check step's (`Recipe.deadlineMs`), counted from the run's start, at most 55 minutes (above).
- **The recipe's step ids, the batch's path and its lane do not change**: no `step.*` event is written.

### What is recorded
- **`pull_request.base_checked` gets an optional `failed`**: the first reading of the run that did not pass, setup's included, as `step.finished` records it (`GravityReading`). A check that merged cleanly and passed has neither `conflicts` nor `failed`; one that conflicted ran no check.
- **What a run that read nothing records**: a worktree it could not make, a merge-tree that failed, or a stop record nothing and are reported, as ADR 0198's failed fetch is; the next pass hands the run on again. Every other reading that did not pass is recorded, `unstarted` and `killed` included: a check the sandbox cannot start fails each pass the same way, and says so once.
- No new event type: the fold keeps `failed` on the check (`BaseCheck`), and an older Foedrum that reads a log with one refuses it, as for any new field.

### What is posted, and what the status comment says
- **A failure is posted when it first appears or when another check fails**, as one comment on the pull request through the ledger, `[batch, "base_check_failed.<n>"]`, found by its marker (ADR 0033), beside the conflicts' `base_conflict.<n>` (`baseConflictEffects`, `src/engine/base-check.ts`). The same check failing at the next tip posts nothing; a pass, a conflict or another check in between makes the next failure post again. A check is the same by its name, or its command line for a literal command, or its being the setup.
- **The comment** says that the base moved, to which commit, that the pull request still merges cleanly, which check failed and how (`the check "test" (npm test) failed with exit code 1`), its tail in a code block whose fence is longer than any run of backticks in it, and that the batch stays On tap.
- **The status comment** shows the latest check of each pull request, extending `baseCheckLine`: `fails the check "test" (npm test) on the merged tree with main at <tip>` for a failure, its tail being on the pull request; and when the latest check is clean and an earlier one failed, `passes its checks on the merged tree with main again at <tip>`, as it says "merges cleanly again" after a conflict. Nothing is posted when it passes again.

### Size and split
About 1,400 lines with tests: the run and its record about 900, the comment on the pull request about 300, the design pages and this record the rest. The work is split: #511 delivers the run, its record and the status comment's line; the comment on the pull request is a new issue, so a failure first shows in the status comment only.

## Consequences
- An open pull request that merges cleanly into a moved base but no longer passes its checks there says so in its batch's status comment within a pass and a run, whoever merged into the base.
- Each moved tip costs one run of the setup and the checks per open pull request with checks, one after another in the Cellar: on a busy base with many open pull requests, the queue keeps only each one's newest tip, and a run can lag the base by the length of the queue.
- A run competes with the brewers' attempts for the machine as a check step does.
- A check that reads git history fails on the merged tree; a repository whose checks do needs them in green only, or says so in its own check.
- `pull_request.base_checked` may carry `failed`: an older Foedrum cannot read a log or state branch that holds one.
- `test/integration/merge-tree.test.ts` makes the folder with real git, in a blobless clone too, and shows that a hook and a configured filter of the clone's do not run.

## Alternatives considered
- **Run the checks in the intake pass.** Its deadline is half a batch lease; a suite would be cut off every pass.
- **A step attempt in the batch's log**, under a reserved step id with the driver's lease and the supervisor's deadline. It would add a step the recipe does not have, to the path line and the status comment, and a lane change out of On tap, which `decide`, the fold and the admission would all need: the way back from On tap is the repair's to settle, with the Blender and the fix round.
- **A driver effect through the ledger.** Effects have a deadline of minutes and renew no lease during one (ADR 0044); a suite outlasts them, and the result is a fact to record, not a side effect to apply once.
- **A worktree of the clone at a commit of the merged tree.** The history for a check, but the clone's configuration (a filter, a `.gitattributes` driver) takes part in the checkout, a commit and a worktree record to clean up, and the check sandbox would bind the clone's git directory.
- **ADR 0164's merge in a fresh worktree.** The same, and a merge commit nobody pushes.
- **Record the clean merge-tree at once and the run's result as a second event.** Two records per tip, and a rule in the admission that the second follows the first; nothing recorded until the run ends gives the same recovery with one.
- **Run every named check of the repository.** It would read checks green does not, and a literal command of a Brewery's recipe would not count.
- **One run per repository at a time, several repositories at once.** The issue's wording; two suites at once beside the brewers is load the machine already feels, and one queue is simpler.
