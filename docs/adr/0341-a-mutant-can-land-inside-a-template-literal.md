# 0341. A mutant can land inside a template literal

Date: 2026-11-06 · Status: Accepted · Amends [0034](0034-brett-mutants-as-structured-line-edits.md) (a template literal is not one string under the word rule) and [0311](0311-brett-s-mutants-of-a-target-land-on-lines-the-change-added-in-a-code-area-of-the-test-map.md) (the replacement rule reads template literals in JavaScript and TypeScript)

## Context
[ADR 0034](0034-brett-mutants-as-structured-line-edits.md)'s word rule says a replacement uses no identifier, keyword or string its original lacks, so that a mutant is a small bug and never a new capability.
`names` in `src/checks/mutants.ts` finds strings with one regular expression, which reads a whole template literal as one quoted token.
So any edit inside a literal is a new string: `${a > b}` to `${a >= b}` gives `` the replacement adds `n ${a >= b}` ``.
Nobody decided that: the rule was written about new strings, and a literal's own words and expressions were caught with them.
In the self-brew trial (#374), on #866, Brett's two mutants of the line that change was about came back invalid, and a person had to probe it by hand.
Foedrum's user-facing lines are nearly all template literals, and that trial's findings were about those lines.

The same regular expression leaves two gaps the other way.
It pairs backticks without knowing `${}`, so the text of a nested literal reads as bare words: `` alpha(`${`gamma ${beta}`} `) `` knows `gamma` as a word, and `gamma` may replace `alpha`.
And `` x(`/`) `` to `` x(`/) ``, which leaves a literal open, is valid: nothing checks that a mutant still parses, on any line.
A mutant that does not parse shows only afterwards, in the engine as `the mutant broke the build` ([ADR 0313](0313-the-engine-runs-brett-s-mutants-in-scratch-trees-against-a-fresh-baseline.md)).

## Decision
- **In JavaScript and TypeScript a line is read for its template literals.** For the `.js`, `.mjs`, `.cjs`, `.jsx`, `.ts`, `.mts`, `.cts` and `.tsx` extensions, in any case, `readTemplates` reads a line token by token into its code and its literals' text, with its plain strings and comments as they are in code, a `${}` as code, and a literal nested in one as text again.
- **The code's rule stays, and the text gets one of its own.** A name or string in the replacement's code must be in the original's code, as today. A word in the replacement's text must be somewhere on the original line, in its code or its text, outside its comments and plain strings. So a mutant may reorder or drop a literal's words, change its punctuation and digits, change an expression, or take a `$` off a `${}`.
- **No word of the text becomes code.** A word only the text holds is not in the original's code, so `` `eval ${a}` `` to `` `${eval} a` `` is invalid, as a mutant cannot turn commented-out code on. Taking the backslash off `` \${eval} `` or `` \` `` is the same case, since an escaped one is text.
- **New words stay refused in the text.** `passed` to `failed` needs `failed` on the line. A mutant of words is still a mutant: a test that pins those words kills the drop or the reorder. A word that is free would let a model's text into a literal that may be a shell line or a query, in a test run. An escape's character is no word, unless it is numeric and could spell one (`\x65val`).
- **A tagged template is text too.** `` sql`select a from b` `` to `` sql`select b from a` `` is valid. It can change a query, with the words already on the line.
- **A replacement must leave its literals as closed as the original did.** One that leaves a literal open where the original closed it, or the other way round, is refused: `the replacement breaks a template literal`. This is not a parser: a `(` left open in a `${}` is valid, as on any other line, and shows as a broken build.
- **A line it cannot trust is held to both rules.** The reading sees one line and knows no regular expression literal. So it is not sure of a line where a slash in the code comes before a backtick or a `}` that ends a `${}`, or where a word follows a closing backtick, which is no JavaScript and means that backtick opened the line's next literal. For such a line the literal check above does not apply, and the replacement must pass ADR 0034's rule as well as the reading's when both lines are read, so it is never looser than before.
- **Everything else stays.** A line with no literal, or one that starts or ends inside a multi-line literal, keeps ADR 0034's rule, and it gained only the check that it keeps its lone backtick. A plain string is one string still. Other languages' backticks stay one string, whatever their strings interpolate.
- **Both checks get it.** `replacementReason` is the one rule of `mutantCheck` and of `/brew-review`'s `scripts/mutants/core.ts` ([ADR 0311](0311-brett-s-mutants-of-a-target-land-on-lines-the-change-added-in-a-code-area-of-the-test-map.md)). The default Brett's prompt says what it may do in a literal and its `version` goes up, and the review's reviewer prompt and skill say the same.

**Migration:** none in a Brewery's files. A Brewery with its own `brewers/brett.md` keeps its words and gets the wider check anyway, since the check is in the engine.

## Consequences
- A line of template text gets mutants, and a surviving one shows a line whose words no test pins.
- A mutant gives up `passed` to `failed`, the most natural bug in a line of words, unless `failed` is on the line. A person who wants that one still probes it by hand.
- A line with a division before a backtick (`` a / b + `c d` ``, or `${a / b}` in a literal) stays refused as before, since it cannot be told from a regular expression. That refuses more than it needs to, and never less.
- A change of whitespace alone still changes nothing, so `` `a / b` `` to `` `a/b` `` is refused though a test could see it, as in a plain string.
- A line that closes a multi-line literal and opens the next, with a space or a mark after the second backtick (`` end`, ` start ``), reads as one literal between the two backticks, and a word of its real text may become code. Reading the file above it would tell, and is not done. Today's rule already lets a word of such a line's text become code, and the line is one the change added, the case [ADR 0311](0311-brett-s-mutants-of-a-target-land-on-lines-the-change-added-in-a-code-area-of-the-test-map.md) accepts for a comment in another language.
- The check on a review takes its rule from the pull request's base ([ADR 0034](0034-brett-mutants-as-structured-line-edits.md)), so this rule first applies to the review after this one merges.

## Alternatives considered
- **Any word in a literal's text.** It is what the issue's first words might read as, and it would keep `passed` to `failed`, at the price of a free channel for a model's text into what may be a shell line. The rule's reason for being is that a mutant adds no capability, and that still holds.
- **A real parser for the parse check.** `src/checks/mutants.ts` imports nothing at run time, since the review copies it from the base, and its rule is language-neutral. The engine already reports a mutant that does not parse.
- **Fall back to ADR 0034's rule alone on a line it cannot trust.** That is what the first version did. A generated test then found the mis-paired nested literal on those lines, so they are now held to both.
- **The same reading for plain strings or other languages' interpolation.** Plain strings can be edited word by word by the same idea, and Kotlin, C# and Python have literals of their own. Neither was asked for: the trial's lines were template literals. Each would be a decision of its own.
