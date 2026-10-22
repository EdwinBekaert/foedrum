# Tasting

**Tasting through lenses:** the Taster reviews through one lens per session (correctness, security, cross-platform, design conformance, test design; [ADR 0022](../../adr/0022-five-default-lenses.md)) in a parallel group.
Brett proposes mutants as one-line structured edits ([ADR 0034](../../adr/0034-brett-mutants-as-structured-line-edits.md)); the engine confirms which ones the tests miss, counting only a test the mutant makes fail ([ADR 0040](../../adr/0040-brett-covers-scripts-and-kills-need-a-failing-test.md)), and these findings are advisory by default.

Default **tasting lenses** (`defaults/lenses/*.md`): correctness, security, cross-platform, design conformance, test design.
A Brewery adds or overrides lenses by committing files to `lenses/`: a file of the same name replaces the default, and a brewer input `"from": "lens:<name>"` takes the lens's text ([ADR 0098](../../adr/0098-foedrum-s-defaults-load-under-the-brewery-s-files-and-a-brewer-input-can-name-a-lens.md)).
Test-first and lenses: [ADR 0017](../../adr/0017-test-first-recipes-and-tasting-lenses.md); the fifth lens: [ADR 0022](../../adr/0022-five-default-lenses.md).

**Parallel groups.** Every child is its own attempt with its own lease and deadline; the group ends when all children end.
The group's `verdict` is `approve` only when every child that returns a verdict approves.
Their time counts against the recipe budget.

**Brett's mutants are checked by the engine.** Brett proposes a few mutants, each as a one-line structured edit (`file`, `line`, `original`, `replacement`), never a patch ([ADR 0034](../../adr/0034-brett-mutants-as-structured-line-edits.md)).
The engine checks each edit (an existing file under `src/` or `scripts/`, a line whose text is `original`, no new identifier or string), applies a valid one with an exact line replacement in a disposable `scratch` tree and runs the gravity reading.
Only a test that fails because of the mutant catches it: the reading is compared test by test with the reading of the unmutated tree, so a test that fails anyway, a time budget or a coverage threshold does not count ([ADR 0040](../../adr/0040-brett-covers-scripts-and-kills-need-a-failing-test.md)).
Only mutants the tests do not catch are **confirmed survivors**.
They are listed in the pull request description and handed to the Cooper together with the lens findings whenever it runs; they block the verdict only when `"blocking": true`.
