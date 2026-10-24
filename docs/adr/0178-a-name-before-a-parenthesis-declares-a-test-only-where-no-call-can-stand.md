# 0178. A name before a parenthesis declares a test only where no call can stand

Date: 2026-10-24 · Status: Accepted · Amends [0176](0176-a-test-s-name-is-declared-only-where-a-declaration-writes-it.md) (the form of an identifier right before `(`, and its known limit for a free function's call)

## Context
The red proof finds the tests a step added by looking up each reported name in the lines the step added, in the forms [ADR 0176](0176-a-test-s-name-is-declared-only-where-a-declaration-writes-it.md) lists. One form is an identifier right before `(`, after something that is no letter, digit, underscore or dot (`void adds(`, `def test_adds(`). A call of a free function has the same shape: an older passing test reported as `parser > parse` has the short name `parse`, and a new test's body line `const tree = parse(input);` counts as declaring it. The older test is then taken for one the step added, and the red proof refuses the step: `test "parser > parse" passes before the implementation`. ADR 0176 records this as a known limit (#469, found in the review of #468).

What stands before a declared name on its line is a declaration's own words: modifiers, a return type, an annotation, a receiver (`public void adds(`, `async Task Adds(`, `fun adds(`, `func (s *Suite) TestAdds(`, `List<int> adds(`, `int *adds(`). What stands before a called name is an expression's: an assignment, an argument list, an operator or a keyword that takes an expression.

## Decision
The form of an identifier right before `(` (ADR 0176’s second form) counts only where something stands before the name on its line, and that text, with whitespace (`\s`) skipped back from the name, ends in none of these:
- a pair, checked before the single characters: `=>`, `->`, `::`, `&&`, `||`;
- a character that opens or continues an expression: `=` (so also `==`, `+=`), `(`, `,`, `[`, `{`, `!`, `:`, `+`, `-`, `/`, `%`, `|`, `^`, `~`, `;`, and `?` after whitespace or at the line’s start (a conditional, `x ? parse(a)`, or a formatter’s `? parse(a)` on a line of its own);
- a word that takes an expression after it, matched as a whole word and case-sensitive: `return`, `await`, `yield`, `throw`, `raise`, `new`, `typeof`, `in`, `of`, `case`, `else`, `do`, `then`, `if`, `elif`, `while`, `unless`, `until`, `when`, `match`, `with`, `defer`, `go`, `not`, `and`, `or`, `assert`.

With nothing before the name, at the line’s start after whitespace, the form does not count: there a call (`parse(input);`, `run(` of a call broken over lines, `withServer(async (url) => {`) and a declaration look the same.

What does count before the name is a declaration’s own words and marks: modifiers, a return type, an annotation (`@Test void adds(`, `public async Task Adds(`), `*` and a single `&` (`int *adds(`, `Foo& adds(`), a `>` not part of `=>` or `->` (a generic’s close, `List<int> adds(`, also `>>` in `Map<String, List<Int>> adds(`), `?` right after a letter, digit or `>` (a nullable type, `Task? Adds(`, `List<int>? Adds(`), and `)` (a Go receiver, `func (s *Suite) TestAdds(`).

The text before is checked at every place the name stands in the line, not only the first, and only from there backwards over whitespace, so the match stays linear in the line, which is model output. The other forms of ADR 0176 stand unchanged.

## Consequences
- An older test named after a free function the step calls is no longer taken for the step’s: in an assignment, an argument, an arrow function or lambda (`() => parse(x)`, `x -> parse(x)`), a `return`, an `await`, a condition, a statement of its own, or a call broken over lines. The known limit ADR 0176 records for `const tree = parse(input);` is closed, and so is a C++ member call through a pointer (`calc->Add(1, 2)`), which ADR 0176’s form took for a declaration.
- Declarations lost: an undecorated class method at the start of its line (`adds() {`), which none of the test styles the red proof’s tests cover writes, and a C++ method defined outside its class (`void CalcTest::testAdds()`), whose declaration in the class (`void testAdds();`) is still found when the step adds it. A test found by no form is not counted as the step’s, as ADR 0176 records.
- Still taken as a declaration: a call after `*`, a single `&`, a `>` not part of `=>` or `->`, `?` right after a word or `>`, or `)`; and after a word not on the list. The lists grow by a change to the engine, with a test.
- An older test whose name is a string in a line the step added (`{ kind: 'null' }`) is still counted as the step’s, as ADR 0176 records.

## Alternatives considered
- **Count the form only after a declaration keyword (`void`, `def`, `fun`, `function`, `func`, `public`, …):** a list per language, and a return type such as `List<int>` or `Task` is any word.
- **Drop the form:** `void adds()` in JUnit, xUnit and NUnit, and `def test_adds():` in pytest, are found only by it.
