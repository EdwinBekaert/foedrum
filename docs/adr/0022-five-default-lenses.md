# 0022. Five default lenses: test design joins the four

Date: 2026-10-15 · Status: Accepted

## Context
[ADR 0017](0017-test-first-recipes-and-tasting-lenses.md) ships four default lenses: correctness, security, cross-platform and design conformance. Test strength had no lens of its own: correctness ended with a short "Tests" section, and Brett's mutants are advisory. In M0's second wave, weak tests got through review that way: unit tests that built real git repositories (#51, which led to [ADR 0021](0021-unit-tests-spawn-no-processes.md)), rejection tests that passed against a reject-everything `z.never()` stub (#47), and a success-path test that passed against a stub with no entry point (#46).

Under test-first, the tests are what Cellarman implements against and what the red proof measures. A test that cannot fail, or that tests git instead of Foedrum, makes the red proof and every later gravity reading prove less. Spotting that takes a focused reading of the tests, which a correctness reviewer looking for logic errors and missing deadlines does not give them. The checks that need no judgement (no process in `test/unit/`, a time budget per test file) are deterministic and run in the checks (#58), not in a lens.

## Decision
- A fifth default lens, **test design** (`defaults/lenses/test-design.md`), reviews the tests in a change. It looks for tests that test the tool instead of Foedrum's code, tests that cannot fail, tests that are red for the wrong reason, slow or heavy tests, hand-written fixtures, and behaviours or error paths that no test pins down.
- The default lenses are now **correctness, security, cross-platform, design conformance and test design**. This amends the list in ADR 0017; everything else in it stands (one Taster session per lens in a `parallel` group, a Brewery adds or overrides lenses).
- Correctness no longer reviews tests: its "Tests" section moves to the new lens, so the two do not report the same gap twice. Each other lens names test design in its "Leave to other lenses" section.
- The lens checklist is the one source for these rules. The Gauger's instructions (#25) refer to it instead of repeating it, so the brewer that writes the tests and the Taster that reviews them read the same rules.

## Consequences
- One more Taster session per tasting round, in parallel with the others, so wall time barely changes but tokens go up by about a fifth of the tasting cost. A recipe can leave the lens out of its group.
- Brett and the test-design lens complement each other: the lens reasons about why a test cannot fail; Brett's survivors are measured evidence that it did not.
- The planted-defect sample for `/brew-review` gains two test-design defects (a unit test that runs git; a rejection test that passes against a reject-everything stub), so a prompt change that weakens the lens shows up there.

## Alternatives considered
- **Keep tests in correctness:** no extra session, but tests stayed a footnote at the end of a long lens, and the defects above got through.
- **Make Brett blocking:** stronger evidence of weak tests, but nondeterministic mutants would strand batches (ADR 0017), and Brett does not see slow tests or tests of the tool.
- **Only deterministic checks:** they catch a process in a unit test and a slow file (#58), but not a test that cannot fail or a stub that returns instead of throwing.
