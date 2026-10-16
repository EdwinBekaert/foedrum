# 0034. Brett's mutants are one-line structured edits, not patches

Date: 2026-10-16 · Status: Accepted · Amends [0017](0017-test-first-recipes-and-tasting-lenses.md)

## Context
ADR 0017 has Brett propose each mutant "as a patch", which the engine applies in a disposable `scratch` tree. The review skill for Foedrum's own pull requests runs the same check by hand, and it showed that a model does not write reliable patches. In the review of PR #100, every patch Brett returned had malformed hunk headers (the line counts did not match the lines), so `git apply` rejected all of them. Each was a single-line substitution, and the review applied it as text by hand. Patches that do apply are not exact either: `git apply` slides a hunk to wherever its context matches, so a wrong line number goes unnoticed, and so would a hunk that lands on a different, similar line.

A check that the engine runs on its own must not depend on a model getting a diff format right. The validity rules (only existing files under `src/`, no new identifiers or strings) are also easier to check on a known edit than on the added lines of an arbitrary patch.

## Decision
- **Brett gives each mutant as a one-line structured edit:** `{ file, line, original, replacement, description }`. `file` is the path from the repository root. `line` is the line number at HEAD. `original` is the whole text of that line. `replacement` is the new text, one line; an empty `replacement` deletes the line. Brett never writes a patch or diff.
- **The checker, not the model, applies it.** The engine (and the review skill, through `scripts/mutants.ts`) checks each edit and applies a valid one with an exact line replacement in the `scratch` tree. Indentation, line endings and a byte order mark stay as they are. A patch for the report is made from the scratch tree (`git diff`), never written by a model.
- **Validity, checked on the edit:**
  - `file` is an existing regular file under `src/` in the scratch tree. A path with `..`, `.`, empty segments, backslashes or a drive is invalid, and so is a file that a link takes out of `src/` or a `src/` that is itself a link.
  - The edited line is the one whose text, ignoring leading and trailing whitespace, is `original`: line `line` when it matches, otherwise the only line that does. Reviewers' line numbers are often off, and the text is what makes the edit exact. A text found on no line, or on several lines none of which is `line`, is invalid.
  - `replacement` is one line (U+2028 and U+2029 count as line breaks), changes more than whitespace anywhere on the line, and uses no identifier, property name, keyword or string that `original` does not contain outside a comment, so a mutant cannot turn commented-out code on. A mutant may change operators and number or boolean literals, or delete or reorder code on that line: a small bug, never a new capability.
- Everything else in ADR 0017's Brett stands: the engine decides which mutants survive, survivors are advisory by default, and nothing Brett changes is committed.

## Consequences
- No mutant is lost to a malformed patch, and an invalid mutant comes with a reason the checker states (`no line of … is the original`, `the replacement adds …`).
- A mutant changes one line. A bug that needs two lines changed together (a removed `try` and its `catch`) cannot be expressed. Most of the bugs Brett is asked for (an inverted condition, an off-by-one, a dropped `await`, a removed deadline, a wrong default) are one line.
- The review skill takes the checking script from the base of the pull request, like the secret scan, so a pull request cannot loosen the rules its own mutants are checked by.
- The review skill's checker (`scripts/mutants.ts`, `scripts/mutants/core.ts`) is development tooling and reads the skill's own file, so it validates by hand. When the engine's Brett is built, its out doc gets a zod schema in `src/schemas/` (CLAUDE.md, TypeScript), which becomes the single source of the shape, and the checker uses it.

## Alternatives considered
- **Keep patches and repair hunk headers.** Recounting the lines fixes this one failure but keeps the fuzzy placement of `git apply`, and the allowlist still has to be checked on the added lines of an arbitrary diff.
- **A unique snippet instead of a line (`original` as any exact, unique substring of the file, as issue #43 first proposed).** It allows multi-line edits, but a short snippet is often not unique, and checking the allowlist against an arbitrary span is harder to state. The line number plus the line's text is simple to check and still exact.
- **Line number only.** Reviewers' line numbers are often wrong (in the planted-defect run of #104, lines 27 and 34 for lines 13 and 20 of a 20-line file), so good mutants would be invalid or hit the wrong line.
