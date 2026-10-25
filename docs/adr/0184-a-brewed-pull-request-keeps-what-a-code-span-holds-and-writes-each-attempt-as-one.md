# 0184. A brewed pull request keeps what a code span holds, and writes each attempt as one

Date: 2026-10-25 · Status: Accepted · Amends [0167](0167-a-brewed-pull-request-follows-one-layout-and-opens-as-a-draft-unless-every-taster-approves.md) (`unlinked` keeps what a code span closed on its line holds, and the brew table writes each attempt as a code span)

## Context
The brewed pull request's layout takes out of model text what GitHub would act on outside a fence (`unlinked`, [ADR 0167](0167-a-brewed-pull-request-follows-one-layout-and-opens-as-a-draft-unless-every-taster-approves.md)): the `@` of a mention, a closing keyword before an issue reference, and the `&` of a character reference.
ADR 0167 does this inside inline code too, and rejected keeping code spans as written, for the cost of a Markdown parser or a dependency.
GitHub reads no mention, closing keyword or character reference inside a code span.
On the fifth brew (#479) the Cellarman's before/after table held `` `@Test void parse() {` ``, a Java annotation, and the pull request showed `Test void parse() {`.
The same layout writes its attempts table as `| gauge #1 | succeeded |`, and GitHub links `#1` to issue 1 of the repository, so every attempt linked an unrelated issue (#479).
The status comment already writes an attempt as a code span ([ADR 0154](0154-lane-labels-on-the-order-s-issue-and-the-status-comment-s-path-line.md)).

## Decision
- **`unlinked` leaves what a code span holds as written, and removes as before everywhere else.** A span is paired as CommonMark pairs one, within one line: a run of backticks that no backslash escapes, its text, and the next run of exactly as many backticks on the same line. A run with no such partner is text and pairing goes on after it, as in CommonMark, so a span left open is not a span and its `@` is removed: it fails closed.
- Where Foedrum's reading could differ from GitHub's, there is no span, failing closed too: a line that holds a `<`, a `]` or a `$` has none, since an HTML tag or an autolink, a link's destination or title (`` [x](`y) @ann ` ``: found in the review of #490), and maybe GitHub's math are read before a span and can take a backtick from it, and what follows a span that holds a `|` on its line has none, that span included, since a table splits its cells first and a span paired from inside it could hold what GitHub reads as text.
- **A line that leaves its reading open makes the lines after it have no span, until a blank line**: a run with no partner on its line, a `<`, a `]` or a `$`, or a span that holds a `|`. GitHub pairs a span, and reads an HTML tag, over the lines of a paragraph, so a backtick left open on one line can take a backtick of the next, and what Foedrum would pair there as a span GitHub reads as text (`` `a ``, then `` b` @ann `x` ``: found in the review of #490). No paragraph, and so no span or tag in one, goes on over a blank line.
- The removals are applied again until nothing changes, with the spans paired again each time, so a removal that changes how the line pairs is read as the new line pairs.
- A cell of the before/after table is made one line, its backslashes and pipes are escaped and it is cut to 200 characters before `unlinked`, so the spans are paired in the text GitHub reads, and a cut cannot leave a kept `@` in a span it opened. Since `unlinked` makes a cell longer by the `amp;` its character references get, it is cut shorter, by the share it grew, until what `unlinked` makes of it fits in 200: 20 rows of grown cells could otherwise pass GitHub's 65,536 characters. **See it** is made one line before `unlinked` too, since it is shown on one.
- **The brew table writes each attempt as a code span** (`` `gauge #1` ``), as the status comment does, so no attempt links an issue.

## Consequences
- `` `@Test` `` and `` `@types/node` `` in a section show as written, and ping nobody; `@Test` outside one still shows `Test`.
- A closing keyword and a character reference inside a span show as written.
- Inline code over two lines, on a line with a `<`, a `]` or a `$` (`` `List<String>` ``, a link, a shell prompt), holding a `|` or after one that does, or after any of these in its paragraph, loses its `@` as before. A fenced block's opening line leaves its run open, so a span right after a fence, without a blank line between, does too.
- A before/after cell whose character references grow it is cut shorter than 200 characters.

## Alternatives considered
- **Keep ADR 0167's reading, inline code included.** It costs a Java annotation, a scoped package and an e-mail-like name in every brew that quotes code, for no safety: GitHub reads none of them there.
- **Strip with a Markdown parser.** Still a dependency or a parser of our own; pairing spans on one line takes a few lines, and what it cannot pair it reads as text, so it fails closed as ADR 0167's filter does.
- **Write the attempt as `gauge 1` or `gauge (#1)`.** The status comment's form is already a code span; one form for both reads the same everywhere.
