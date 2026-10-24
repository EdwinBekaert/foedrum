# Tasting

**Tasting through lenses:** the Taster reviews through one lens per session (correctness, security, cross-platform, design conformance, test design; [ADR 0022](../../adr/0022-five-default-lenses.md)), in lens steps one after another or side by side in a parallel group.
A lens step is a Taster's step with a `lens`: a Taster is a brewer whose out doc schema is `tasting`, and the default one is `defaults/brewers/taster.md`, read-only ([ADR 0161](../../adr/0161-lens-steps-run-a-taster-whose-findings-are-advisory-unless-the-step-blocks.md)).
The step's lens reaches the Taster as its input `lens`, and a Taster that reviews a diff also gets the input `change`: the commits and the diff from the commit its batch started at to HEAD, or from the base a merge before its last check brought in ([ADR 0164](../../adr/0164-a-batch-merges-its-base-before-its-last-check.md)), the log by first parents only, which the engine reads with git in the repository's clone, with no diff driver, and holds to 256 KiB, so the Taster runs no shell.
A Finer gets the same input ([fining](fining.md)).
Its out doc adds `findings`, each with `severity` (`blocker`, `major`, `minor`), `why`, `introduced`, and `file` and `line` unless it is about the change as a whole, and a `verdict`, `approve` or `changes`, which must be `changes` exactly when a finding the change introduced is a `blocker` or `major`.
Findings are advisory: the pull request's body ([openPullRequest](open-pull-request.md)) and the status comment ([GitHub](../humans/github.md)) list them, and the batch goes on.
The Tasters' verdicts decide whether the pull request opens as a draft ([openPullRequest](open-pull-request.md)).
With `"blocking": true` on the step, the runner settles a `changes` verdict as blocked by findings, so the step's `onBlocked` route sends the batch back with the Taster's out doc, and after its rounds the batch is Stuck.
A `lens` on a brewer that is no Taster, a Taster's step without one, and a lens no folder has fail the load with a line each.
Brett proposes mutants as one-line structured edits ([ADR 0034](../../adr/0034-brett-mutants-as-structured-line-edits.md)); the engine confirms which ones the tests miss, counting only a test the mutant makes fail ([ADR 0040](../../adr/0040-brett-covers-scripts-and-kills-need-a-failing-test.md)), and these findings are advisory by default.

Lenses live in two folders, by what they review ([ADR 0143](../../adr/0143-lenses-in-two-folders-diff-and-plan.md)): `lenses/diff/` for a diff (code) and `lenses/plan/` for a plan (an order's breakdown, #391), in the Brewery and in `defaults/lenses/`.
A lens is named by its folder and file name, `diff/security` or `plan/coverage`, so the two folders can hold a lens of the same file name.
Default **tasting lenses** (`defaults/lenses/diff/*.md`): correctness, security, cross-platform, design conformance, test design; `defaults/lenses/plan/` has none yet.
A Brewery adds or overrides lenses by committing files to `lenses/diff/` or `lenses/plan/`: a file of the same folder and name replaces the default, and a brewer input `"from": "lens:diff/<name>"` or `"lens:plan/<name>"` takes the lens's text ([ADR 0098](../../adr/0098-foedrum-s-defaults-load-under-the-brewery-s-files-and-a-brewer-input-can-name-a-lens.md)).
A step with a `lens` reviews a diff once a step before it (in the order the recipe lists its steps, nested ones included) produces commits, and a plan otherwise; a lens of the other folder fails the load with a line that names the step and the lens, and a lens file directly in `lenses/` fails it with a line that says where it belongs.
Test-first and lenses: [ADR 0017](../../adr/0017-test-first-recipes-and-tasting-lenses.md); the fifth lens: [ADR 0022](../../adr/0022-five-default-lenses.md).

**Parallel groups.** A `parallel` step's children are Tasters' lens steps without `when`, and a child whose brewer is no Taster, or produces commits, fails the load, so no child writes the task tree ([ADR 0168](../../adr/0168-a-parallel-group-runs-its-lens-steps-side-by-side.md)).
Each child is a step of its own, with its own attempts, lease, worktree, deadline and stall limit, and the status comment lists the children where the group stands.
Entering the group schedules every child at once; a failed child is tried again on its own, and a child that makes the batch Stuck does so at once, abandoning the children still in flight.
A child ends when its latest attempt succeeded, or was blocked by findings with its route's rounds not used up; the group ends when every child ended.
Then a blocking child's `changes` sends the batch back along that child's `onBlocked` route, the first such child in the recipe's order, and otherwise the group's verdict is `approve` and the batch goes on.
A `retry` or `answer` of a child also schedules every child of its group that has not ended, a `skip` of a child skips the rest of its group, and a `rewind` to a child runs the whole group again; a rewind or a route back to the group itself is refused, and so is a child's route back to a sibling.
The batch leaves a group only while no attempt of it runs.
A group whose recipe file gained a child while the batch was in it makes the batch Stuck on a divergence, naming that child.
A kill mid-group retries only the children that had not ended: the supervisor loses one attempt of a batch per tick and keeps the expired leases of the others for the ticks after.
Each child's time counts toward the recipe's budget, summed, once a budget is built (#445).

**Brett's mutants are checked by the engine.** Brett proposes a few mutants, each as a one-line structured edit (`file`, `line`, `original`, `replacement`), never a patch ([ADR 0034](../../adr/0034-brett-mutants-as-structured-line-edits.md)).
The engine checks each edit (an existing file under `src/` or `scripts/`, a line whose text is `original`, no new identifier or string), applies a valid one with an exact line replacement in a disposable `scratch` tree and runs the gravity reading.
Only a test that fails because of the mutant catches it: the reading is compared test by test with the reading of the unmutated tree, so a test that fails anyway, a time budget or a coverage threshold does not count ([ADR 0040](../../adr/0040-brett-covers-scripts-and-kills-need-a-failing-test.md)).
Only mutants the tests do not catch are **confirmed survivors**.
They are listed in the pull request description and handed to the Cooper together with the lens findings whenever it runs; they block the verdict only when `"blocking": true`.
