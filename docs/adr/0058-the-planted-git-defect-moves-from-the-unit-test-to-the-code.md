# 0058. The planted git defect moves from the unit test to the code

Date: 2026-10-17 · Status: Accepted · Amends [0022](0022-five-default-lenses.md) (its consequence for the planted-defect sample)

## Context
ADR 0022 had the planted-defect sample for `/brew-review` (`test/fixtures/brew-review/planted-demo/`) gain two test-design defects, so that a prompt change that weakens the test-design lens shows up in a planted run: a rejection test that passes against a reject-everything stub, and a unit test that runs git (`0005`, `git init` in `test/unit/current-branch.test.ts`).

Since ADR 0038, `npm test`'s preload refuses every process start in a test process. The mutation check of `/brew-review` runs the sample's tests with that preload (ADR 0040), so the planted unit test failed at the sample's head without any mutant. ADR 0040 keeps that from counting as a kill, but the sample's baseline was still red: every planted run compared a broken fixture, and a test that already fails cannot kill a mutant of `current-branch.ts` (#43).

A unit test that starts a process cannot be planted in the sample and also pass at its head: the preload exists to make exactly that test fail.

## Decision
- **The test moves, the defect stays in the code.** `0005` puts the current-branch test in `test/integration/`, where real git is allowed (ADR 0021), so the sample's unit tests pass at its head under the preload. The planted defect is `0006`: `currentBranch` runs git with `execFileSync`, not through the process runner, so it has no deadline, no tree kill (ADR 0035) and no runner that a unit test could fake.
- **Other lenses are expected to report it.** Design-conformance and cross-platform cite the CLAUDE.md rule to spawn git through the process runner. Test-design may add that the only test is an integration test, but the sample's README no longer requires it.
- **A unit test guards the baseline.** `test/unit/planted-demo.test.ts` runs the layer guard of `npm run check` on the lines the patches add, so no patch gives a test in a layer `npm test` runs a direct import of `child_process` or the process runner. Like the guard, it does not see a start through an imported module. The preload catches that when the sample's tests run.

## Consequences
- The sample plants one test-design defect (the reject-everything stub) instead of two. A prompt change that stops test-design from flagging unit tests that start processes no longer shows up in a planted run. The layer guard of `npm run check` and the ADR 0038 preload enforce that rule mechanically, so the lens is the second line there, not the only one.
- The sample's baseline passes, so every mutant verdict in a planted run names the test that killed it, and mutants of every planted file can be judged.
- The planted process start now tests design-conformance and cross-platform on code, which ADR 0022's two defects did not cover.

## Alternatives considered
- **Give the unit test a fake process runner.** That removes the defect altogether, and `0006`'s direct `execFileSync` could no longer be tested by it.
- **Plant a different test-design defect that keeps the baseline green**, such as a unit test that only tests a fake runner's canned output. It is a weaker test-design case than one that breaks a written rule. It also adds a ninth patch, and the README's table, the red proof's expected results and earlier runs would all need redoing. The process-start rule is already enforced twice outside the lens.
- **Keep the failing unit test and live with the red baseline.** Rejected: that is the #43 problem.
