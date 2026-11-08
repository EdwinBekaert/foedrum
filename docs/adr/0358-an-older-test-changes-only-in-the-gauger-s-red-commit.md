# 0358. An older test changes only in the Gauger's red commit

Date: 2026-11-08 · Status: Accepted · Amends [0066](0066-the-task-tree-continues-from-the-latest-succeeded-attempt.md) (an attempt at the step a red proof proves starts at that step's own latest success, not at the task tree) and [0274](0274-the-red-proof-reads-line-coverage-of-the-change-and-a-test-map-not-test-names.md) (`testsUnchanged` also refuses a change to a test file the batch's base holds)

## Context
A test-first change updates an existing assertion that the new behaviour changes in its red commit, beside the new tests, so it fails there and passes at green (CLAUDE.md, Tests).
In a brew the Gauger writes the red commit, and `testsUnchanged` kept only the lines it added ([ADR 0274](0274-the-red-proof-reads-line-coverage-of-the-change-and-a-test-map-not-test-names.md)).
In 3 of the first 4 self-brews with `nip` (#859, #868, #958), a test changed in the Cellarman's commit, after the code.
In #859 and #958 a test that existed before the batch pinned the old behaviour: the Gauger did not update it, green failed on it, and the Cellarman changed it.
In #868 the Cellarman added a small test of its own in its implementation commit, as its prompt asks for a changed line no test runs.
The per-commit red proof of `/brew-review` then read the pull request's history as a test changed after the code, and #958 was closed for it.

Sending such a test back to the Gauger alone does not help: a route back starts its attempt at the task tree, the branch of the latest success ([ADR 0066](0066-the-task-tree-continues-from-the-latest-succeeded-attempt.md)), which holds the Cellarman's code.
The Gauger's update would land after the code, and with the code in place the updated test passes, so the red proof finds no failing test and fails.
Nip's route from the Cellarman's findings back to the Gauger ([ADR 0064](0064-test-first-recipes-when-onblocked-and-a-red-proof-required.md)) had the same flaw whenever an earlier Cellarman attempt had succeeded.

Decided by the maintainer on #861 (2026-11-08).

## Decision

### The Gauger updates the older tests the change breaks
- The Gauger's prompt has it search the existing tests for those the order's change will break (the messages, values, names and outputs it changes), update their expected values in its red commit, and name each in `tests`, since each now fails for the missing behaviour.
- On a round a route sent back, `{route}` names the tests that failed or that a brewer found wrong; the Gauger updates each one the order changes, and ends blocked with findings for one that is right as it stands.
- The red proof needs nothing new: an updated older assertion that fails lies in a test file the step changed, which its check 4 asks for.

### No later brewer changes a test file the base holds
- `testsUnchanged` (`guardTests`, `src/checks/tests-guard.ts`) also reads, once a guarded attempt succeeded, the attempt's own change, from its start to its branch: from its start merge when it made one, and when that merge kept a conflict, from the merge the brewer concluded (the oldest commit after its start with the moved base as a parent, `git rev-list --parents`), so the moved base's own changes are not the attempt's ([ADR 0244](0244-a-conflict-with-the-moved-base-sends-its-batch-back-to-the-fix-step.md)). The brewer's resolution inside the merge commit counts as the merge's.
- It fails the attempt, retryably, when that change touched a file in a separate test area of the effective map that the batch's base holds (`olderTestFiles`, `src/checks/tests-unchanged.ts`), listed at the base with `ls-tree` in the clone, which is asked only for the changed files in a test area: `the guard testsUnchanged: the attempt changed a test file the batch's base holds, <path>: a test that must change goes back to the Gauger as a finding (ADR 0358)`, with a count when there are more.
- The base is the one the guard already reads the map at: the base the batch merged, else where its change started.
- A file only the batch added, a fixture outside the test areas, code and a module whose tests are `inline` change freely, as before: the guard cannot tell an inline test's lines from code, and the test-design lens reads them.
- A fixture inside a test area that the base holds is refused too: it is an expected value, the Gauger's to change.
- The rule needs no case without a map: the guard runs only for a recipe that proves red, and a test-first batch with no map is Stuck before its first step ([ADR 0297](0297-the-red-proof-reads-a-test-map-only-and-a-test-first-batch-with-none-is-stuck-before-its-first-step.md)). A recipe with no Gauger has no guard, and its Cellarman writes and changes tests as before.
- The default Cellarman and Finer carry the guard. The Cellarman's prompt says that an older test that must change is a finding: it ends blocked with findings naming it, and nip's existing `onBlocked` route takes the batch to the Gauger.

### The Gauger sent back after the code starts before the code
- An attempt at the step the recipe's first red proof proves (`Recipe.proven`, the step whose tests `testsUnchanged` keeps) starts at that step's own latest success, not at the task tree (`attemptStart`, `src/engine/task-tree.ts`), when:
  - that success is in the batch's current run, after its latest rewind or recipe choice ([ADR 0357](0357-after-a-round-back-a-group-runs-again-only-its-every-round-children-and-those-with-findings.md)'s `runFrom`);
  - it wrote in the batch's repository;
  - no open pull request has sent the batch back.
- A resumed success starts at the branch of the worktree its session ran in ([ADR 0117](0117-a-retry-resumes-the-session-of-the-attempt-before-it-in-that-attempt-s-worktree.md)).
- The recipe the attempt was scheduled under decides ([ADR 0310](0310-the-driver-wiring-finds-an-attempt-s-brewer-in-the-recipe-it-was-scheduled-under.md)).
- Only a success moves the task tree, so the Gauger's success moves it to its own branch: the red proof runs on the tests without the code, and the Cellarman starts again from the red proof's tip.
- The history the pull request carries is then the base, the Gauger's commits, then the code: the attempts before the Gauger's round back stay on their branches for a person to read, and never reach the pull request.
- The step's commits are still read from its first attempt's start to its latest success (`stepCommits`), so the red proof and `testsUnchanged` read both of the Gauger's rounds as one change.

### What it costs
In `test/unit/driver.test.ts` a test-first recipe walks the path #958 would take now: green fails on an older test, the Cellarman's second attempt ends blocked with findings, the Gauger's second attempt starts at its first success, and the red proof's second attempt is followed by a third Cellarman attempt, at the red proof's tip.
That is one Cellarman attempt more than #958 took (three against two), besides one more Gauger attempt and one more red proof, and the third writes the code again rather than continuing from the first.

### A Cellarman's own new test
A Cellarman adds a test of its own when a line it changed runs under no test (the uncovered-line check, ADR 0274), and that test sits in its implementation commit, which the per-commit red proof reads as mixed (#868).
Decided by the maintainer: a test such a line needs, in a test file the base holds, is a finding for the Gauger, which the guard above enforces and Nip's `onBlocked` route takes there; a test in a test file only the batch added stays allowed, in the Cellarman's commit.
With one case seen (#868), no engine rule orders it before the code until a brew shows the need.

### After the pull request opened
A route back to the Gauger after an open pull request's check sent the batch back (`onPullRequestFail`, [ADR 0219](0219-a-failing-check-on-an-open-pull-request-sends-its-batch-back-to-a-fix-step.md)) starts at the task tree, as before: the pull request's branch already holds the code, and is never pushed without it, so that update lands after the code.
It needs a test that green's `test` check passed and the pull request's checks failed, such as one only the repository's CI runs; it is not made Stuck.

## Consequences
- A brewed pull request's history keeps every older test's update in a red commit, and the per-commit red proof reads it as the rule asks.
- An older test that must change costs a Cellarman attempt that ends blocked, a Gauger attempt, a red proof and the code written again.
- A genuine regression (the Cellarman's code breaks an older test that is right) stays with the Cellarman: it fixes its code, as before.
- `Recipe` has one more method, `proven`; the fake recipes take `proven`.
- No event, schema or recipe field changes.

### Migration
- A Brewery with its own Cellarman or Finer whose `guards` hold `testsUnchanged` gets the stricter guard with no change to its files. Its prompt should say that an older test that must change ends the attempt blocked with findings, as the default Cellarman's does; otherwise its attempts fail on the guard and are retried until they run out.
- A Brewery with its own Gauger should add the default Gauger's lines on older tests (its third step and its rule "Older tests the order changes are yours").
- A Brewery's own test-first recipe gets the start rule with no change. `foedrum doctor` has nothing to name: every file that loaded still loads.

## Alternatives considered
- **Green's failure on a test the Gauger neither wrote nor named goes straight to the Gauger** (a route field `onOlderTests` on green, chosen by the failing tests' places in the reports against the Gauger's diff). Dropped by the maintainer: the guard already brings such a test to the Gauger through the Cellarman, and a genuine regression would go to a Gauger who can only say the test is right, leaving the batch Stuck where the Cellarman fixes it today. It would have saved one Cellarman attempt per occurrence.
- **Start the Gauger at the task tree and run its red proof on a scratch tree without the code.** The red proof could see the update fail, but the pull request's history would still hold it after the code.
- **Let the Cellarman change an older test and name it, for `/brew-review` to read.** The change would still come after the code, which is what the rule refuses.
- **Rewind the batch through `batch.rewound`.** A rewind is a person's act ([ADR 0025](0025-batch-lifecycle-stuck-reminders-and-rewind.md)), with its `by` and `via`; the start rule needs no event, since where an attempt starts is read from the fold.
