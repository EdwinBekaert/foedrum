# 0452. Green starts at the merged base, and a merge counts only on the head's line

Date: 2026-11-27 · Status: Accepted · Amends [0164](0164-a-batch-merges-its-base-before-its-last-check.md) (a merge counts as the start of the batch's change only on the line to the head the change is read up to), [0244](0244-a-conflict-with-the-moved-base-sends-its-batch-back-to-the-fix-step.md) (a kept merge counts as the base merged at its tip once a success concluded it, and only on the line to the head) and [0274](0274-the-red-proof-reads-line-coverage-of-the-change-and-a-test-map-not-test-names.md) (green's uncovered lines are judged from the merged base)

## Context
Before its last check a batch merges its base ([ADR 0164](0164-a-batch-merges-its-base-before-its-last-check.md)), and a Taster's change, and the push's reading of the change, start at the base that merge brought in. Two things went wrong on 2026-11-26 and 2026-11-27, in #1175 (Brewery #34) and #1185 (Brewery #36).

- **Green counted the base's lines as the batch's.** The uncovered-line check judges the lines the change added ([ADR 0274](0274-the-red-proof-reads-line-coverage-of-the-change-and-a-test-map-not-test-names.md)). #1175 failed green with `1 changed line no test runs: src/cli/serve-config.ts:381`, a line #1201 had merged into main while it brewed. The Cellarman rightly changed nothing, and the batch went Stuck as a divergence.
- **A merge that never reached the branch counted.** `mergedBase` took the latest recorded merge that made a commit, also one a failed attempt made in a worktree whose branch the batch never carried on. #1185's third green merged today's main and failed; its merge was not in the branch's head, which still sat on the base of the day before. The Tasters then read that head against the newer base, and the batch seemed to delete three ADRs and a source file.

## Decision
- **A merge counts only on the line to the head being judged.** `mergedBaseOnLine` (`src/engine/base-merge.ts`) takes the batch's recorded merges that count (a commit of their own, or a kept one a success concluded, [ADR 0244](0244-a-conflict-with-the-moved-base-sends-its-batch-back-to-the-fix-step.md)), latest first, and returns the base of the first whose commit is an ancestor of the head, by git (`git merge-base --is-ancestor`, `isAncestorIn`, `src/workspace/clone-git.ts`). A kept merge records no commit of its own; the base it brought in stands for it, since a head that concluded the merge holds it. When none is on the line the change starts where it would without a merge: at the batch's start.
- **Every reader of the start asks it of the head it reads up to:** a Taster's, a Finer's and Brett's change (the attempt's start commit, or its branch for an attempt that commits, since such an attempt merges the base at its start, after its start commit), the check runner (the worktree's commit), the mutants (the attempt's commit), the red tests and the tests guard (the attempt's branch), and the pull request's push (the commit it pushes, asked when the push applies, since only then is that commit known). A git failure other than "not an ancestor" fails the read, as a git failure does elsewhere.
- **Green starts at the merged base.** The uncovered-line check takes the same start as the other readers of the check runner, so the lines the base brought in never count, and a line of the batch's own that no test runs still fails. Without a merge, nothing changes.

## Consequences
- A batch whose base gained an uncovered line passes green on its own covered change; one with an uncovered line of its own still fails it.
- After a green attempt that merged the base and failed, the Tasters and green read from the batch's start, not from the base that attempt merged, until a merge is on the head's line.
- Each reader asks git once per recorded merge it passes over, at most one per merge of the batch.
- **Migration:** none. Nothing is recorded differently; the merges the ledger holds are read as before.

## Alternatives considered
- **Judging only the merge's own attempt.** The check would read the merge of its own attempt and none other. It would leave the Taster's, the Finer's and the push's reading of a failed attempt's merge wrong.
- **Dropping a failed attempt's merge from the ledger.** The ledger records what happened, and the merge happened; whether it counts is a question of the head being read.
