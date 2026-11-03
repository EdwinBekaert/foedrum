# 0314. A Brett mutant that changes only a comment changes nothing

Date: 2026-11-03 · Status: Accepted · Amends [0311](0311-brett-s-mutants-of-a-target-land-on-lines-the-change-added-in-a-code-area-of-the-test-map.md) (the replacement rule's "more than whitespace changed") and [0034](0034-brett-mutants-as-structured-line-edits.md) (the same rule for Foedrum's own reviews)

## Context
`replacementReason` in `src/checks/mutants.ts` refuses a replacement that "changes nothing", which it found by comparing the two lines with only their whitespace dropped.
So `const rate = base * 2; // doubled`, replaced by `const rate = base * 2;`, was a valid mutant: the comment made the lines differ, and the word rule let it through, since dropping a comment adds no word.
No test can fail on such a mutant, so once the engine runs mutants (#798) and lists survivors (#799) it would be a survivor every time, a gap in the tests that is not there.
Foedrum's own reviews met it too: `scripts/mutants/core.ts` uses the same rule (#807, found in the review of #806).
The word rule already strips `//` and `/* */` comments where they are known, the JavaScript, TypeScript and C-family extensions (ADR 0311).

## Decision
- **Where comments are known, the changes-nothing comparison leaves them out.** Both lines lose their `//` and one-line `/* */` comments, each blanked to a space, before their whitespace is dropped and they are compared; the reason stays "the replacement changes nothing".
- **Strings are kept.** One pass finds strings and comments together, the leftmost first: a comment marker inside a string (`"http://x"`) is the string's, and a quote inside a comment opens no string. A changed string is still a change, even one the original already holds elsewhere on the line.
  A `//` or `/*` right after a backslash is no comment either: it is an escaped slash, as at the end of a regular expression literal (`/^https?:\/\//`), so an operator changed after one is still a change.
- **Elsewhere nothing changes.** In a language whose comments are not known, a comment counts as the line's text, as ADR 0311 says: dropping a Python line's `// limit` is a change, since there `//` is an operator.
- **A line that is only a comment** is a line a change can add in a code area; deleting it, or rewording it, changes nothing where comments are known.

## Consequences
- Brett's comment-only edits come back invalid, with a reason a person can read: from `mutantCheck`, which no engine path calls yet (#798 will), and in `/brew-review`'s mutation check, which no longer reports them as survivors to dismiss by hand.
- A multi-line `/* */` comment is still read line by line: a line inside one that holds no `/*` or `*/` is code to the rule, as it is to the word rule.
- The rule does not read regular expression literals or template strings that span lines, as the word rule does not: a quote inside one (`/'/.test(s) && t === 'a//b'`) can pair with a later quote and leave a `//` after it read as a comment. A mutant after it is then refused as changing nothing, a lost mutant, never one let through.
- `mutantCheck`, its verdict and the line edit are unchanged; only the comparison is.

## Alternatives considered
- **Swap each string for a placeholder, strip comments, and put the strings back.** It gives the same result in two passes and needs a placeholder that no line can hold; one pass whose leftmost match wins needs neither.
- **Blank strings too, as the word rule does.** `"a"` → `"b"` would then read as no change, though a test can see it.
- **Leave it to the reviewer, who dismisses the survivor as equivalent.** When #799 lists the engine's survivors in a pull request, no reviewer will stand between Brett and that list, and the rule already knows where comments are.
