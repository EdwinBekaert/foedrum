# 0465. A step input reads the state branch's copy of an out doc once its worktree is cleaned

Date: 2026-11-27 · Status: Accepted · Amends [0059](0059-attempt-plans-from-the-brewer-of-the-step.md) (a `step:<id>` input is read in the worktree the step ran in) and [0103](0103-out-docs-reach-the-state-branch-through-the-store.md) (nothing reads the state branch's copy back)

## Context
A `step:<id>` input is the out doc of the step's latest succeeded attempt, read in the worktree that attempt ran in ([ADR 0059](0059-attempt-plans-from-the-brewer-of-the-step.md)). When a batch goes on tap, the cleanup removes its attempt worktrees, and the out docs with them ([ADR 0081](0081-the-cleanup-ignores-the-steps-own-out-doc.md)). A pull request's fix route (a conflict with the moved base, failing checks, a review that asks for changes: [ADR 0219](0219-a-failing-check-on-an-open-pull-request-sends-its-batch-back-to-a-fix-step.md), [ADR 0244](0244-a-conflict-with-the-moved-base-sends-its-batch-back-to-the-fix-step.md)) takes the batch back to `implement`, whose Cellarman reads `step:gauge` and `step:map`. Those worktrees are gone, so its plan fails with `the input "tests" was not read: it is missing`. On foedrum#1175 two attempts failed that way at once and the batch was Stuck.

The same out docs are on the state branch, at `batches/<batch>/<step>-<attempt>.md` ([ADR 0103](0103-out-docs-reach-the-state-branch-through-the-store.md)), in the state worktree of the work root. No input read them there.

## Decision
- **A step input reads the worktree first, then the state branch.** The read of `step:<id>` is the one it was: the file the attempt's brewer names, in the worktree the attempt ran in, inside that worktree. When that read says the file is *missing*, the input reads the state branch's copy of the same attempt, `outDocPath` of the batch, the step and the attempt, inside the state worktree (`<work root>/state`), and nowhere outside it.
- **Only a missing file falls back.** A file the worktree has but that cannot be read (too large, not a file) fails the input as before: the state branch's copy is never taken for a file that is there. When neither copy exists the input fails as before, with the same message.
- **The latest succeeded attempt, as before.** The copy is the one of the attempt the input already chose, never an earlier one.
- **The copy is read as the worktree's.** It goes through the same limit and the same removal of the doc's handover as a worktree's read ([ADR 0340](0340-a-brewer-s-handover-is-kept-as-a-proposal-and-reaches-no-later-prompt.md)), and it reaches the prompt as untrusted input like any other.
- **What stays.** The `plan` input and a route's out doc are read in the worktree as before; a route out doc's fallback is for another decision.

## Consequences
- A batch sent back from tap by a pull request's fix route reads the Gauger's tests and the Maltster's map after its worktrees were cleaned, in every recipe that has such a route.
- An out doc over 256 KiB is on the state branch as a fixed line, not its text ([ADR 0103](0103-out-docs-reach-the-state-branch-through-the-store.md)): an input that falls back to it reads that line.
- The state branch holds a doc only after the flush that pushes the event of its `step.finished`. An ended batch's docs have been flushed; a read while the batch lives finds the worktree.

## Alternatives considered
- **Keep the worktrees of a batch on tap until its pull request merges:** reads nothing new, but holds disk for as long as a pull request waits, and a person's merge or close is the cleanup's trigger ([ADR 0037](0037-attempt-worktrees-in-the-engine-and-driver-locks.md)).
- **Always read the state branch:** one place, but a doc written in the attempt's worktree is on the branch only after a flush, so a step right after another would read a doc that is not there yet.
- **Fail the route and let a person rewind:** what happens now.
