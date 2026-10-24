# 0176. A test's name is declared only where a declaration writes it

Date: 2026-10-24 · Status: Accepted · Amends [0078](0078-the-red-proof-reads-the-test-report-and-testsunchanged-compares-lines.md) (which reported tests are the proven step's), [0170](0170-the-red-proof-accepts-the-regression-tests-a-gauger-names.md) (how a regression name is matched)

## Context
The red proof finds the tests the proven step added by looking up each reported test's name in the lines the step added ([ADR 0078](0078-the-red-proof-reads-the-test-report-and-testsunchanged-compares-lines.md)).
A name counted when it stood as a whole word: after something that is no letter, digit, underscore or dot, and before something that is none of those nor a space, or the line's end.
So an older test with a short name that is also a word of code counted as the step's as soon as the step wrote that word.
In the fourth brew (batch `9-1`, #442), `test/unit/frontmatter.test.ts` has a passing table case named `null`; the Gauger added `parent_tool_use_id: null,` and `done({ exitCode: null, … })`, and the red proof refused the step: `test "null" passes before the implementation` (#466).
The Gauger's tests were right, and the step would have gone back to gauge until its attempts were spent.

## Decision
A reported name, in any of the forms ADR 0078 reads it in (whole, without parameters, after suite titles, after a class or module), is declared by a line the step added only where a declaration writes a test's name:
- the whole of a string literal in `'…'`, `"…"` or `` `…` `` (`test('adds two numbers'`, `t.Run("adds"`, Kotlin's `` fun `adds`() ``);
- an identifier right before `(`, after something that is no letter, digit, underscore or dot (`def test_adds(`, `void adds(`);
- an identifier after `def`, `fn` or `func` and a space (Ruby's `def test_adds`, Rust's `fn adds<T>()`);
- the test of a GoogleTest macro (`TEST(CalcTest, Adds)`, `TEST_F`, `TEST_P`);
- the rest of a Gherkin scenario's line (`Scenario:`, `Scenario Outline:`, `Scenario Template:`, `Example:`).

A bare word in code declares nothing: `key: null,`, `f(null)`, `Status: null`.
The rest of ADR 0078's rule stands: a method call (`calc.add(`) and a line that only asserts declare nothing, a carriage return does not count, and a name over 1,000 characters is never the step's.
Each form is the name as a literal between fixed parts, so a match stays linear in the line, which is model output.
A regression name (ADR 0170) is matched through the same forms, so a comment after code no longer declares one unless it holds the name in one of them.

## Consequences
- Batch `9-1`'s gauge step (`b4202db4..b08772ea`) passes the red proof with its 45 tests; the older `null` case is no longer one of them, and no test of the step is lost.
- A declaration in a form not listed is not found: its test is not counted as the step's, and the red proof says none of the report's tests is one the step added, or that a regression test is not one. The list grows by a change to the engine, with a test, as ADR 0078's other lists do.
- An older test whose name is also a string in a line the step added (`{ kind: 'null' }`) is still counted as the step's; a string is how most runners take a test's name, so the red proof cannot tell the two apart.

## Alternatives considered
- **Keep the whole-word rule and refuse names that are keywords of code (`null`, `true`, `None`).** A list per language, and any other short word (`empty`, `value`) has the same fault.
- **Only lines that declare a test (`testsUnchanged`'s list).** `void adds(int a, int b)` follows `@Test` on a line of its own, and a one-line test that holds the word in its body would still count.
- **Diff the report against a run at the step's start.** It finds the new tests exactly, but runs the suite twice per red proof.
