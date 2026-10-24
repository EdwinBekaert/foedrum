# 0178. A name before a parenthesis declares a test only where no call can stand

Date: 2026-10-24 · Status: Accepted · Amends [0176](0176-a-test-s-name-is-declared-only-where-a-declaration-writes-it.md) (the form of an identifier right before `(`, and its known limit for a free function's call)

## Context
The red proof finds the tests a step added by looking up each reported name in the lines the step added, in the forms [ADR 0176](0176-a-test-s-name-is-declared-only-where-a-declaration-writes-it.md) lists. One form is an identifier right before `(`, after something that is no letter, digit, underscore or dot (`void adds(`, `def test_adds(`). A call of a free function has the same shape: an older passing test reported as `parser > parse` has the short name `parse`, and a new test's body line `const tree = parse(input);` counts as declaring it. The older test is then taken for one the step added, and the red proof refuses the step: `test "parser > parse" passes before the implementation`. ADR 0176 records this as a known limit (#469, found in the review of #468).

What stands before a declared name on its line is a declaration's own words: modifiers, a return type, an annotation, a receiver (`public void adds(`, `async Task Adds(`, `fun adds(`, `func (s *Suite) TestAdds(`, `List<int> adds(`, `int *adds(`). What stands before a called name is an expression's: an assignment, an argument list, an operator or a keyword that takes an expression.

## Decision
The form of an identifier right before `(` (ADR 0176's second form) counts only when what stands before the name on the line, with spaces skipped, ends in none of these:
- a character or pair that opens or continues an expression: `=` (so also `==`, `=>`, `+=`), `(`, `,`, `[`, `{`, `!`, `?`, `:`, `+`, `-`, `/`, `%`, `|`, `^`, `~`, `;`, `&&`, `||`;
- a word that takes an expression after it: `return`, `await`, `yield`, `throw`, `new`, `typeof`, `in`, `of`, `case`, `else`, `do`, `if`, `elif`, `while`, `unless`, `until`, `when`, `match`, `not`, `and`, `or`, `assert`.

With nothing before the name, at the line’s start, the form counts only when the line, with a trailing comment left out, does not end in `;` or `)`: `parse(input);` and Python’s or Go’s `parse(input)` are statements, while a declaration goes on with `{`, `:`, `->` or a return type.

`*` and a single `&` count, as a pointer or a reference (`int *adds(`, `Foo& adds(`), and so do `>`, a generic’s close (`List<int> adds(`), and `)`, a Go receiver (`func (s *Suite) TestAdds(`). So `a * parse(x)` is still taken as a declaration; multiplying by a call in a test is rare.

The other forms of ADR 0176 stand unchanged. Each test stays a fixed text or a scan of the line from its end, so a match stays linear in the line, which is model output.

## Consequences
- An older test named after a free function the step calls is no longer taken for the step's, in an assignment, an argument, a `return`, an `await` or a statement of its own: the known limit ADR 0176 records for `const tree = parse(input);` is closed.
- A declaration whose name follows one of those characters or words is no longer found by this form: none of the declarations ADR 0176 lists does, and a one-line test whose declaration sits after `;` on another statement's line is found by none of the forms. Its test is not counted as the step's, as for any form not listed.
- A free function called after `*`, a single `&`, `>` or `)`, or alone on a line that ends in neither `;` nor `)`, is still taken as a declaration. The list grows by a change to the engine, with a test.
- An older test whose name is a string in a line the step added (`{ kind: 'null' }`) is still counted as the step's, as ADR 0176 records.

## Alternatives considered
- **Count the form only after a declaration keyword (`void`, `def`, `fun`, `function`, `func`, `public`, …):** a list per language, and a return type such as `List<int>` or `Task` is any word.
- **Drop the form:** `void adds()` in JUnit, xUnit and NUnit, and `def test_adds():` in pytest, are found only by it.
