# Open pull requests

What the intake does with a batch's pull request after it opens: it records its end, and it checks it against its base whenever the base moves ([ADR 0198](../../adr/0198-an-open-pull-request-is-merge-tree-checked-when-its-base-moves.md)).

- **The end is recorded for every batch On tap**, a Brewery issue's and a claimed issue's alike: `pull_request.ended`, appended when a pass reads a merge or a close (`recordEnds`, `src/engine/intake.ts`).
  A claimed batch's release waits for it ([target-repository issues](target-issues.md)); for a Brewery issue's batch it only ends the checks below.
- **Each pass then checks the open pull requests against their base** (`checkBases`, `src/engine/base-check.ts`): for each batch On tap, the pull request its ledger opened with no recorded end, and the commit its push recorded.
  It reads each base's tip once per pass, as the push's own fetch reads it (`BranchPush.baseTip`, [ADR 0090](../../adr/0090-the-push-fetches-the-base-in-a-git-directory-of-its-own.md)), so a merge into the base by anyone counts.
  A tip the pull request was last checked against, or else the base the batch's last merge read ([ADR 0164](../../adr/0164-a-batch-merges-its-base-before-its-last-check.md)), runs nothing.
  When the tip moved, the bottle branch's tip on the remote is read first (`BranchPush.remoteTip`): when someone else pushed to it, no merge-tree runs and nothing is posted, the check is recorded once with that tip (`branchMoved`), and the pull request is checked no more.
  A tip that moved is merged with the head by `git merge-tree --write-tree` in a git directory of Foedrum's own with the clone's objects, so no hook or merge driver of the clone's takes part (`openMergeTree`, `src/workspace/merge-tree-git.ts`).
  Each check is recorded as `pull_request.base_checked`, with the tip and the conflicting files, at most 50, when there are any.
  A tip or a merge-tree that fails records nothing and is reported; the next pass tries again.
- **A conflict is posted on the pull request** when it first appears or its set of files changes, one comment through the ledger, `[batch, "base_conflict.<n>"]`, found by its marker (`baseConflictEffects`).
  A new tip with the same files, and a clean merge, post nothing.
- **The status comment shows the latest check** under its pull requests: the tip and files of a conflict, that it merges cleanly again after one, or that it is not checked since someone else pushed to its branch; nothing once the pull request ended ([GitHub](../humans/github.md)).
- **The batch stays On tap**: nothing sends it back yet.
  Running the repository's checks on the merged tree is #511.
- **It needs git 2.38**, for `merge-tree --write-tree`: `foedrum doctor` requires it, so `foedrum serve` does not start on an older git ([ADR 0200](../../adr/0200-foedrum-requires-git-2-38.md)).
