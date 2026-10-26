# 0203. An open pull request's checks run on its merged tree when its base moves

Date: 2026-10-26 · Status: Accepted · Amends [0198](0198-an-open-pull-request-is-merge-tree-checked-when-its-base-moves.md) (a clean merge-tree is recorded once the checks on the merged tree have run, with the failing reading when one fails, and the status comment shows it as it shows a conflict), [0069](0069-check-steps-run-the-repositorys-commands-in-an-attempt-of-their-own.md) (the check runner also reads a tree outside a check step's attempt), [0076](0076-check-steps-run-in-an-os-sandbox-with-no-network.md) (the sandbox also binds the object stores a worktree's repository borrows) and [0130](0130-the-cleanup-removes-the-git-directories-of-its-own-a-stopped-call-left.md) (a git directory of its own may now hold a worktree a stopped run left)

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
- **Which checks**: those of the batch's recipe's check step that merges the base before it runs (`Recipe.mergesBase`, [ADR 0164](0164-a-batch-merges-its-base-before-its-last-check.md)), Nip's `green`: the checks the pull request opened on, named checks through the repository's `checks` in `foedrum.jsonc` as for the step, a literal command as it is. A recipe with no such step has none to run.
- **The merged-check run** (`createMergedChecks`, `src/engine/merged-checks.ts`) runs beside the ticks and the intake pass in `foedrum serve`, never awaited by a tick, as the pass is (ADR 0068), and `serve` awaits the run underway when it stops, which a stop ends at once (below).
  - **One at a time in the Cellar**, so one at a time per repository: one Cellar per work root (its driver lock, [ADR 0037](0037-attempt-worktrees-in-the-engine-and-driver-locks.md)), and one run in it. A test suite on every core beside the brewers' attempts is load enough; two at once would slow both.
  - **A queue of the latest due tip per pull request**, in the order they came: a pull request whose base moved again before its run started is run once, at the newest tip; one whose run is underway is queued again at the new tip.
  - **Just before a run**, the log is read again: a batch no longer On tap, a pull request with a recorded end, or a check already recorded at that tip drops the run.
  - **Nothing is recorded until the run ends.** A kill of `serve` (Ctrl+C, a SIGKILL, a power cut) during a run leaves no record, so the next pass finds the tip moved since the pull request's last check and hands the run on again: no run is lost, and none is recorded twice. A stop ends the run's processes through its abort signal, and a run that read a `stopped` reading records nothing either.
  - **No lease and no ledger entry for the run**: no other driver runs it (only `serve` has an intake), and it has no external side effect: its record is an event.
- **Why not an attempt in the batch's log.** ADR 0069's "attempt of its own" is a worktree of its own, never an earlier attempt's, the check runner, and a deadline; the run has all three without being a step attempt (Alternatives).

### The tree it runs on
- **A worktree of a git directory of Foedrum's own, at a commit of the merged tree** (`openMergedTree`, `src/workspace/merge-tree-git.ts`), all within one `withOwnGitDir` call ([ADR 0090](0090-the-push-fetches-the-base-in-a-git-directory-of-its-own.md)), so no hook and no configuration of the clone's takes part:
  - the run merge-trees head and tip again (`--write-tree`, whose first output is the merged tree's id);
  - `git commit-tree <tree> -p <head> -p <tip>` makes the commit, with Foedrum's own name as author and committer, so the user's configuration need not name one;
  - the directory gets the clone's tags and remote-tracking refs (`refs/tags/*`, `refs/remotes/*`, with `update-ref --stdin`), so `git describe` or a log of the base reads in the merged tree what it reads in a check step's worktree;
  - `objects/info/alternates` names the clone's object store, so git in the worktree, which runs without the call's `GIT_OBJECT_DIRECTORY`, finds the clone's objects;
  - `git worktree add --detach <worktree> <commit>` makes the worktree beside the directory, `<uuid>.tree` next to `<uuid>.git`; in a blobless clone the blobs the checkout needs come from the URL Foedrum names, as the merge-tree's do.
  Both go when the run ends, also when it fails.
- **The sandbox binds the stores a repository borrows** (amends ADR 0076): besides the worktree's repository, read-only, each object store its `objects/info/alternates` names, read-only, on Linux and macOS. Foedrum writes that file in its own directory, which the sandbox binds read-only and no check writes, as it does the worktree's record (`worktreeGitDir`). Without it, the clone's objects, under a hidden home folder, would be out of reach and every git command in a check would fail.
- **ADR 0130's cleanup** removes a `<uuid>.git` older than its floor of one hour, and with it now the `<uuid>.tree` beside it, which a killed run leaves. A run lasts at most the step's deadline (30 minutes for Nip's `green`) and the checkout's 5 minutes; a deadline of a recipe's own over 55 minutes is cut to 55 for the run, so the floor holds.

### How it runs: as a check step's attempt does
- **Through the check runner's own path** (`checkTree`, `src/checks/check-runner.ts`, which a check step's attempt now also runs through): the repository's setup first, with the network (ADR 0140), then each check in order through the check sandbox (ADR 0076), the first that does not pass ending the run; the brewers' minimal environment; the time left until 10 seconds before the run's deadline as each command's timeout, as ADR 0069 says; the readings and their tails cut and filtered for secrets as a check step's are.
- **Its deadline** is the check step's (`Recipe.deadlineMs`), counted from the run's start, at most 55 minutes (above).
- **The recipe's step ids, the batch's path and its lane do not change**: no `step.*` event is written.

### What is recorded
- **`pull_request.base_checked` gets two optional fields**, at most one of them on a check, and neither with `conflicts`:
  - `failed`: the first reading of the run that did not pass, setup's included, as `step.finished` records it (`GravityReading`);
  - `unchecked`: why the checks did not run on a clean merge, in one line of at most 500 characters: the merged tree could not be made (the merge-tree, the commit or the worktree failed), or a named check of a repository `foedrum.jsonc` lists no checks of.
  A check that merged cleanly and passed has neither.
- **Each tip is run at most once.** A run that cannot start records `unchecked` for that tip, so the next pass sees it checked and hands nothing on until the tip moves again: a broken worktree or setup costs one run per base move, not one per pass, and the reason survives a restart. A setup or a check that does not pass is a `failed` reading, `unstarted` and `killed` included. Only a stop records nothing.
- No new event type: the fold keeps `failed` and `unchecked` on the check (`BaseCheck`), and an older Foedrum that reads a log with one refuses it, as for any new field.

### What the status comment says
- **The latest check of each pull request**, extending `baseCheckLine`: `fails the check "test" (npm test) on the merged tree with main at <tip>` for a failure; `is not checked on the merged tree with main at <tip>: <why>` for `unchecked`; and when the latest check passed and an earlier one failed or was unchecked, `passes its checks on the merged tree with main again at <tip>`, as it says "merges cleanly again" after a conflict.
- **The comment on the pull request is #526's**: this decision posts nothing for a failure; its status line is where it shows until then.

## Consequences
- An open pull request that merges cleanly into a moved base but no longer passes its checks there says so in its batch's status comment within a pass and a run, whoever merged into the base.
- Each moved tip costs one run of the setup and the checks per open pull request with checks, one after another in the Cellar: on a busy base with many open pull requests, the queue keeps only each one's newest tip, and a run can lag the base by the length of the queue.
- A run competes with the brewers' attempts for the machine as a check step does.
- A failure that went away by itself (a flaky test, a registry outage in setup) stays in the status line until the tip moves again.
- `pull_request.base_checked` may carry `failed` or `unchecked`: an older Foedrum cannot read a log or state branch that holds one.
- `test/integration/merge-tree.test.ts` makes the worktree with real git, in a blobless clone too, shows that `git log` and `git describe` work in it, and that a hook of the clone's does not run.

## Alternatives considered
- **Run the checks in the intake pass.** Its deadline is half a batch lease; a suite would be cut off every pass.
- **A step attempt in the batch's log**, under a reserved step id with the driver's lease and the supervisor's deadline. It would add a step the recipe does not have, to the path line and the status comment, and a lane change out of On tap, which `decide`, the fold and the admission would all need: the way back from On tap is the repair's to settle, with the Blender and the fix round.
- **A driver effect through the ledger.** Effects have a deadline of minutes and renew no lease during one (ADR 0044); a suite outlasts them, and the result is a fact to record, not a side effect to apply once.
- **A folder of the merged tree's files with no git** (`read-tree -u` into it). Simpler, but a check that reads history (`git describe`, a version script, a hook manager in setup) would fail on the merged tree and pass on the branch, a failure that is not real.
- **A worktree of the clone at the merged commit.** The clone's configuration (a filter, a `.gitattributes` driver) would take part in the checkout.
- **ADR 0164's merge in a fresh worktree.** The same, and a merge commit nobody pushes.
- **Record the clean merge-tree at once and the run's result as a second event.** Two records per tip, and a rule in the admission that the second follows the first; nothing recorded until the run ends gives the same recovery with one.
- **Count the runs that could not start in memory and give up after a few.** It forgets on a restart and shows nowhere; a recorded reason does both.
- **Run every named check of the repository.** It would read checks green does not, and a literal command of a Brewery's recipe would not count.
- **One run per repository at a time, several repositories at once.** The issue's wording; two suites at once beside the brewers is load the machine already feels, and one queue is simpler.
