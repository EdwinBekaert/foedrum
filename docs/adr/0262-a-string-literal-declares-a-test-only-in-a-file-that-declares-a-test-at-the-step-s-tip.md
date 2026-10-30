# 0262. A string literal declares a test only in a file that declares a test at the step's tip

Date: 2026-10-30 · Status: Accepted · Amends [0078](0078-the-red-proof-reads-the-test-report-and-testsunchanged-compares-lines.md) (the step's tests are found by a string literal only in its test files, read at its tip, and `t.Run(` is a declaration), [0176](0176-a-test-s-name-is-declared-only-where-a-declaration-writes-it.md) (the whole-string-literal form counts only in a file that declares a test at the step's tip)

## Context
The red proof finds the tests a step added by looking up each reported leaf name in the lines the step added, in any file of its diff, in the forms [ADR 0176](0176-a-test-s-name-is-declared-only-where-a-declaration-writes-it.md) lists ([ADR 0078](0078-the-red-proof-reads-the-test-report-and-testsunchanged-compares-lines.md)).
A regression name is matched only in the lines of a file where the step declared a test ([ADR 0170](0170-the-red-proof-accepts-the-regression-tests-a-gauger-names.md)).
In a live Nip run (Brewery batch 12-2, #661), the Gauger's commit regenerated `schemas/event.json`, which adds `"type": "array",`.
That quoted `"array"` read as a declaration of two existing tests named `array` (`parseJsonc > plain JSON > array`, and a frontmatter case).
Both pass before the change, so the red proof refused the step (`test "array" (and 8 more) passes before the implementation`), and the Gauger could not name them as regression tests, since `event.json` declares no test.

Three ways to tell a test file were weighed:
- **A file where the step added a line that declares a test** (`declaresTest`: `test(`, `def test…(`, `@Test`, …). Held to every form, it broke 17 of 93 `judgeRed` cases with real runner forms the list does not know: Gherkin's `Scenario:`, Ruby's `def test_adds`, a Java method without a new `@Test`. Held to string literals only, it still missed the most common way a Gauger writes a red test: a row added to an existing table (`test.each([...])`, a Go table under an existing `t.Run(tt.name, …)`), whose added lines declare nothing.
- **The files the test report names.** node's TAP gives no location for a passing test, which is the one that matters here, and a JUnit `file` attribute is optional in most runners.
- **A path rule** (`.test.`, `_test.go`, `test_*.py`, …). It would be a new list per language.

## Decision
- **A test file is a file the step changed that declares a test at the step's tip**: a line of it, as the step left it, that `declaresTest` reads as a declaration.
  For a file whose added lines declare none, the red proof reads the file once at the branch the step's commits end at, in the clone (`readTestFiles`, `src/checks/step-commits.ts`), within the diff's 16 MiB limit and 10 s, at most 50 such files, since the brewer's commits choose how many change.
  A file git cannot find there, one past the limit, a binary one, one past that count and a file the step deleted are no test files; a read git was killed for blocks the red proof on its environment, as an unreadable diff does.
  `judgeRed` stays pure: it is given those paths.
- **A whole string literal declares a test only in a test file**: in any other file, such as a regenerated schema, a fixture or a lock file, a quoted name is data.
  A data file (JSON, YAML, a lock file) is no test file, unless its text reads as a declaration to `declaresTest` (#618 owns that list).
- **Every other form of ADR 0176 counts in any file, as before**: after `def`, `fn` or `func`, a GoogleTest macro's test, a Gherkin scenario's line, and a name before `(` where no call can stand (ADR 0178).
- **Regression names still match only in files whose added lines declare a test**, outside comments, as [ADR 0170](0170-the-red-proof-accepts-the-regression-tests-a-gauger-names.md) has it: those are the files whose lines `testsUnchanged` keeps.
  So a table row cannot be a named regression test.
- **Go's `t.Run(` is a declaration** (`DECLARATIONS`, `src/checks/tests-unchanged.ts`), so a Go file whose tests are subtests is a test file.
  `testsUnchanged` then also keeps the `t.Run` lines a step added, as it keeps every declaration the step added.

## Consequences
- Batch 12-2's commit no longer counts the two older `array` tests: `judgeRed` on its diff (`b972823b..201956ae`) proves its new tests red.
- A row the step adds to an existing table-driven test counts again as one of its tests, since the table's file declares a test at the tip.
- The red proof makes one more git call for each changed file whose added lines declare no test, for at most 50 of them.
- `declaresTest` reads text, not code, so a source file can declare a test at its tip by prose or by a call that only looks like one: a comment `names it (ADR 0213)`, or zod's `.describe('…')`. In such a file string literals count, as they did before this decision; so they do in a data file whose text reads as a declaration, such as a schema generated from a `.describe()` text with `it (` in it.
- The list of declarations stays incomplete for some languages and loose for others; [#618](https://github.com/EdwinBekaert/foedrum/issues/618) (the red proof must know a step's tests in every language) revisits it as a whole.
