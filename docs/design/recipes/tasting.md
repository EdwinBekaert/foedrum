# Tasting

**Tasting through lenses:** the Taster reviews through one lens per session (correctness, security, cross-platform, design conformance, test design; [ADR 0022](../../adr/0022-five-default-lenses.md)), one lens step after another until parallel groups land (#428).
A lens step is a Taster's step with a `lens`: a Taster is a brewer whose out doc schema is `tasting`, and the default one is `defaults/brewers/taster.md`, read-only ([ADR 0161](../../adr/0161-lens-steps-run-a-taster-whose-findings-are-advisory-unless-the-step-blocks.md)).
The step's lens reaches the Taster as its input `lens`, and a Taster that reviews a diff also gets the input `change`: the commit its batch started at, to read the change with `git diff` and `git log`.
Its out doc adds `findings`, each with `severity` (`blocker`, `major`, `minor`), `why`, `introduced`, and `file` and `line` unless it is about the change as a whole, and a `verdict`, `approve` or `changes`.
Findings are advisory: the pull request's body and the status comment list them, and the batch goes on.
With `"blocking": true` on the step, the runner settles a `changes` verdict as blocked by findings, so the step's `onBlocked` route sends the batch back with the Taster's out doc, and after its rounds the batch is Stuck.
A `lens` on a brewer that is no Taster, a Taster's step without one, and a lens no folder has fail the load with a line each.
Brett proposes mutants as one-line structured edits ([ADR 0034](../../adr/0034-brett-mutants-as-structured-line-edits.md)); the engine confirms which ones the tests miss, counting only a test the mutant makes fail ([ADR 0040](../../adr/0040-brett-covers-scripts-and-kills-need-a-failing-test.md)), and these findings are advisory by default.

Lenses live in two folders, by what they review ([ADR 0143](../../adr/0143-lenses-in-two-folders-diff-and-plan.md)): `lenses/diff/` for a diff (code) and `lenses/plan/` for a plan (an order's breakdown, #391), in the Brewery and in `defaults/lenses/`.
A lens is named by its folder and file name, `diff/security` or `plan/coverage`, so the two folders can hold a lens of the same file name.
Default **tasting lenses** (`defaults/lenses/diff/*.md`): correctness, security, cross-platform, design conformance, test design; `defaults/lenses/plan/` has none yet.
A Brewery adds or overrides lenses by committing files to `lenses/diff/` or `lenses/plan/`: a file of the same folder and name replaces the default, and a brewer input `"from": "lens:diff/<name>"` or `"lens:plan/<name>"` takes the lens's text ([ADR 0098](../../adr/0098-foedrum-s-defaults-load-under-the-brewery-s-files-and-a-brewer-input-can-name-a-lens.md)).
A step with a `lens` reviews a diff once a step before it (in the order the recipe lists its steps, nested ones included) produces commits, and a plan otherwise; a lens of the other folder fails the load with a line that names the step and the lens, and a lens file directly in `lenses/` fails it with a line that says where it belongs.
Test-first and lenses: [ADR 0017](../../adr/0017-test-first-recipes-and-tasting-lenses.md); the fifth lens: [ADR 0022](../../adr/0022-five-default-lenses.md).

**Parallel groups.** Every child is its own attempt with its own lease and deadline; the group ends when all children end.
The group's `verdict` is `approve` only when every child that returns a verdict approves.
Their time counts against the recipe budget.

**Brett's mutants are checked by the engine.** Brett proposes a few mutants, each as a one-line structured edit (`file`, `line`, `original`, `replacement`), never a patch ([ADR 0034](../../adr/0034-brett-mutants-as-structured-line-edits.md)).
The engine checks each edit (an existing file under `src/` or `scripts/`, a line whose text is `original`, no new identifier or string), applies a valid one with an exact line replacement in a disposable `scratch` tree and runs the gravity reading.
Only a test that fails because of the mutant catches it: the reading is compared test by test with the reading of the unmutated tree, so a test that fails anyway, a time budget or a coverage threshold does not count ([ADR 0040](../../adr/0040-brett-covers-scripts-and-kills-need-a-failing-test.md)).
Only mutants the tests do not catch are **confirmed survivors**.
They are listed in the pull request description and handed to the Cooper together with the lens findings whenever it runs; they block the verdict only when `"blocking": true`.
