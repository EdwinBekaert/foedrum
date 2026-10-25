# 0182. A call after a less-than or a closing brace declares no test

Date: 2026-10-25 · Status: Accepted · Amends [0178](0178-a-name-before-a-parenthesis-declares-a-test-only-where-no-call-can-stand.md) (two characters join the list of what opens an expression)

## Context
The red proof counts an identifier right before `(` as a test's declaration only where something stands before it on its line that does not end in an expression's opening ([ADR 0178](0178-a-name-before-a-parenthesis-declares-a-test-only-where-no-call-can-stand.md)).
`<` and `}` are not on that list, so a call after either still counts: `if (limit < parse(input)) {` or `} parse(input);` beside an older passing `parser > parse` makes the red proof take the older test for the step's and refuse the step, the #469 defect again (#486, found by the review of #479).
No declaration writes its name right after `<` or `}`: a generic's open (`List<int>`, `template<typename T>`) is followed by a type, and the name comes after its close.

## Decision
`<` and `}` join ADR 0178's characters that open or continue an expression.
A name right after either, with whitespace skipped back from the name, no longer counts as a test's declaration.
`<=` was already covered by `=`; `<` alone, `<<` and `}` now are.
The pairs, the words and the rest of ADR 0178 stand unchanged.

## Consequences
- An older test named after a free function the step calls in a comparison (`limit < parse(input)`) or after a block's close on the same line (`} parse(input);`) is no longer taken for the step's.
- A generic return type still declares (`List<int> parse() {`, `template<typename T> void parse() {`): the text before the name ends in `>` or a word, not in `<`.
- Still taken as a declaration: a call after `*`, a single `&`, a `>` not part of `=>` or `->`, `?` right after a word or `>`, `)`, `]`, a quote, `@`, `#`, `$`, and after a word not on the list. The lists grow by a change to the engine, with a test.

## Alternatives considered
- **Add `]`, a quote, `@`, `#` and `$` too:** no reported step has met a call after one of them, and `@` and `$` stand in some languages' declarations (an annotation, a sigil); each joins with a test when a case shows it is needed.
