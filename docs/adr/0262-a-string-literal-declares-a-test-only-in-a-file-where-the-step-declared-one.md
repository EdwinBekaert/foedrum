# 0262. A string literal declares a test only in a file where the step declared one

Date: 2026-10-30 · Status: Accepted · Amends [0078](0078-the-red-proof-reads-the-test-report-and-testsunchanged-compares-lines.md) (the step's tests are found by a string literal only in its test files, and `t.Run(` is a declaration), [0176](0176-a-test-s-name-is-declared-only-where-a-declaration-writes-it.md) (the whole-string-literal form counts only in a file where the step declared a test)

## Context
The red proof finds the tests a step added by looking up each reported leaf name in the lines the step added, in any file of its diff, in the forms [ADR 0176](0176-a-test-s-name-is-declared-only-where-a-declaration-writes-it.md) lists ([ADR 0078](0078-the-red-proof-reads-the-test-report-and-testsunchanged-compares-lines.md)).
A regression name is matched only in the lines of a file where the step declared a test ([ADR 0170](0170-the-red-proof-accepts-the-regression-tests-a-gauger-names.md)).
In a live Nip run (Brewery batch 12-2, #661), the Gauger's commit regenerated `schemas/event.json`, which adds `"type": "array",`.
That quoted `"array"` read as a declaration of two existing tests named `array` (`parseJsonc > plain JSON > array`, and a frontmatter case).
Both pass before the change, so the red proof refused the step (`test "array" (and 8 more) passes before the implementation`), and the Gauger could not name them as regression tests, since `event.json` declares no test.

Matching every new test only in the step's test files, as regression names are, would refuse real tests: a file is a test file when the step added a line `declaresTest` knows (`test(`, `def test…(`, `@Test`, …), and that list does not know Gherkin's `Scenario:`, Ruby's `def test_adds` without parentheses, a Java method without a new `@Test`, or a Go subtest.
Tried on the unit tests of `judgeRed`, it broke 17 of 93 cases.

## Decision
- **A whole string literal declares a test only in a file where the step declared a test**: in any other file, such as a regenerated schema, a fixture or a lock file, a quoted name is data.
- **Every other form of ADR 0176 counts in any file, as before**: after `def`, `fn` or `func`, a GoogleTest macro's test, a Gherkin scenario's line, and a name before `(` where no call can stand (ADR 0178).
- **Regression names are matched as before**: only in the lines of a file where the step declared a test, outside comments ([ADR 0170](0170-the-red-proof-accepts-the-regression-tests-a-gauger-names.md)).
- **Go's `t.Run(` is a declaration** (`DECLARATIONS`, `src/checks/tests-unchanged.ts`), so a Go subtest a step adds inside a test it did not add makes its file a test file, whose string literals then declare.
  `testsUnchanged` then also keeps those `t.Run` lines, as it keeps every declaration the step added.

## Consequences
- Batch 12-2's commit no longer counts the two older `array` tests: `judgeRed` on its diff (`b972823b..201956ae`) proves its new tests red.
- A test declared only by a string literal in a file where the step added no other declaration the list knows is no longer found:
  - a Kotlin test whose `@Test` line the step did not add (a new test brings its own `@Test`);
  - a row the step adds to an existing table-driven test, such as `test.each([...])` in JavaScript or a Go table whose `t.Run(tt.name, …)` line was already there.
  When such a row is the step's only new test, the red proof refuses it (`none of the … tests in the report is one the step added`). When the step also adds other tests, the row is not judged, so a row that passes before the change goes unseen.
- The list of declarations stays incomplete for some languages; [#618](https://github.com/EdwinBekaert/foedrum/issues/618) (the red proof must know a step's tests in every language) revisits it as a whole.
