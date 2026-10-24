# 0167. A brewed pull request follows one layout, and opens as a draft unless every Taster approves

Date: 2026-10-24 · Status: Accepted · Amends [0071](0071-the-openpullrequest-action-two-effects-of-the-batch.md) (the pull request's body and whether it is a draft) and [0088](0088-out-doc-text-that-looks-like-a-secret-is-left-out-of-the-pull-request-and-the-status-comment.md) (the body reads its new sections for secrets, and gives its reports at most 25,000 characters) and [0059](0059-attempt-plans-from-the-brewer-of-the-step.md) (a `pullRequest` out doc is read against its own schema)

## Context
The openPullRequest action opens a batch's pull request with the order's title and a body of `Brewed by Foedrum from <order>.`, each step's report in one fenced block, and `Closes <order>` ([ADR 0071](0071-the-openpullrequest-action-two-effects-of-the-batch.md)).
It opens ready for review.
The first orders Foedrum brewed on itself (#374) opened pull requests that broke the target repository's own rules: no "How it works" section, no picture, no **See it** line, and ready with no review (#410, #431).
The consultant rewrote each description by hand (#443 is the layout).
Any team whose repository has rules of its own for a pull request would have to do the same.

#412 settled it with the maintainer on 2026-10-23: the Cellarman writes the sections and the engine builds the body; one fixed layout for every repository; draft or ready by the Tasters' verdicts.
Merging the base before the pull request is [ADR 0164](0164-a-batch-merges-its-base-before-its-last-check.md)'s.

## Decision

### The Cellarman writes the sections
- **A brewer whose out doc schema is `pullRequest`** (`output.schema`) writes the pull request's sections, as a Taster is one whose schema is `tasting` ([ADR 0161](0161-lens-steps-run-a-taster-whose-findings-are-advisory-unless-the-step-blocks.md)). Its out doc adds three optional fields to the contract (`PullRequestOutDoc`, `src/schemas/out-doc.ts`):
  - `howItWorks`: Markdown, at most 10,000 characters, which part of the repository the change touches and what it does, with one Mermaid picture where the change has a shape;
  - `seeIt`: one line of at most 1,000 characters, how a person sees the change work;
  - `beforeAfter`: optional, at most 20 rows of `{ "case", "before", "after" }`, each one line of at most 200 characters, which the engine renders as a table, so the model writes no table syntax.
- **The default Cellarman answers with `pullRequest`** (`defaults/brewers/cellarman.md`, version 4), and its prompt says what each field holds. No extra brewer run.
- The limits keep the body under GitHub's 65,536 characters without cutting Markdown in the middle: an out doc past them is invalid, and its attempt is tried again with the reason. A missing section is not: a retry would redo the whole run (Cellarman's deadline is 30 minutes) for a few lines of description, so the pull request has no such section instead.

### The engine builds the body
- **One fixed layout**, for every target repository (`pullRequestText`, `src/engine/pull-request.ts`):
  1. `## How it works`, then `howItWorks`, then the before/after table when there is one, then `**See it:** <seeIt>`, each when the out doc has it, from the latest out doc of the batch that has any of them (the step scheduled last, its latest attempt that succeeded). A batch with none (a recipe without such a brewer) has no such section.
  2. `## How this was brewed`: `Brewed by Foedrum from <owner/name>#<n> with the recipe <name>.`, a line that says why the pull request is a draft or ready, and a table of every finished attempt in the order the attempts started (`Batch.path`): `<step> #<n>` and its result in the engine's words (`succeeded`, a Taster's `approve` or `changes`, `failed`, `needs input`, `cancelled`, `abandoned`), at most 50 rows and a count of the rest. A failed attempt adds its reason, which is what makes the table worth reading (`the red proof of step gauge failed: test "…" passes`). The reason can hold a model's words (a test name, a failed out doc's summary), so it is read for secrets as the reports are, its control characters and line breaks are shown as `\uXXXX` escapes as `foedrum brew` shows a line ([ADR 0123](0123-foedrum-brew-drives-one-batch-under-an-owner-of-its-own.md)), its runs of more than three backticks are cut to three, it is cut to 200 characters, and it sits in a code span longer than any run of backticks in it, where GitHub links, mentions and closes nothing. The action's own attempt is still running and is not listed.
  3. The step reports, as ADR 0071 and ADR 0161 quote them, in their fenced `text` block, folded in `<details><summary>What each step reported</summary>`.
  4. `Closes <owner/name>#<n>`, the order's issue, which the engine writes itself.
- **The model's sections go through two filters**, in this order:
  - **Secrets** ([ADR 0088](0088-out-doc-text-that-looks-like-a-secret-is-left-out-of-the-pull-request-and-the-status-comment.md)): `howItWorks`, `seeIt` and each table cell is read whole with `withoutSecrets`, and a match leaves that whole text out, with the fixed line naming its step in its place.
  - **The frame** (`unlinked`, `src/engine/pull-request.ts`): the text is not fenced, so GitHub would read it. An `@` that starts a mention (at the start, or after anything but a letter or digit, before a letter or digit) is removed, so nobody is pinged; an `_` before it counts as a start, since emphasis with `_` (`_@ann_`) renders as a word that starts there. A closing keyword (`close`, `closes`, `closed`, `fix`, `fixes`, `fixed`, `resolve`, `resolves`, `resolved`, any case) after anything but a letter or digit, followed, after anything but letters and digits, by an issue reference (`#`, `GH-`, `owner/name#`, a URL) is removed. Every `&` that starts a character reference, named or numeric (`&` before `#` or a letter, but not `&amp;`), becomes `&amp;`, since GitHub decodes `&commat;` to `@` and `&num;` to `#`: a keyword or an `@` spelled with one stays text. The three are applied again until nothing changes, so `closes closes #3` does not leave a `closes #3`. The reference itself stays and links, and closes nothing.
  - **Blocks that end where they start** (`closedBlocks`): `howItWorks` is Markdown that comes before the engine's lines, and an unclosed fence (a picture cut short is enough) or an HTML block (`<!--`, `<details>`, which CommonMark runs to its end tag or the end of the body) would swallow the rest of the body, the draft line, the findings and `Closes` included. So a fence `howItWorks` leaves open is closed with its own run, and a line outside a fence that starts, after up to three spaces, with `<` starts with `&lt;` instead. Inline HTML (`a <b>bold</b> word`) stays: it ends with its paragraph. A line in a fence stays as written, so a Mermaid label keeps its `<br/>`.
  - **Room**: once made safe, `howItWorks` may be at most 12,000 characters and `seeIt` 1,200, since `&amp;` and `&lt;` make them grow; a section past that is left out whole, with `[left out: a text of step <step> that is too long once made safe for GitHub]`, as cutting it could break its Markdown.
  - A table cell also has its line breaks made spaces, its backslashes doubled and its `|` escaped, so a cell stays a cell, and is cut to 200 characters. A reason's pipes are escaped wherever an even run of backslashes comes before them, since a code span does not read backslashes but the table does.
- **The step reports get what the rest of the body leaves of GitHub's 65,536 characters, at most 25,000**, where ADR 0088 gave them 60,000. They are read up to 1,000 characters past that, by ADR 0088's rule, and cut short there, saying so. Since `&#` grows to `&amp;#` and a cell's backslashes double, the sections can take more than their limits, so the room is worked out from the body built before the reports, never a fixed share, and is never below zero.

### Draft or ready by the Tasters' verdicts
- **The pull request opens ready only when a Taster tasted the change and every Taster approved**: at least one step report has a Taster's verdict, and every verdict is `approve`. Otherwise it opens as a draft: when no step tasted it (the recipe has no lens step, or its `when` skipped them), or when a Taster's verdict is `changes`, whose findings are already listed among the reports (ADR 0161). A blocking Taster's `changes` sends the batch back before this (ADR 0161), so only an advisory one reaches the pull request.
- The body's line says which: `Ready for review: every Taster approved.`, `A person reviews this before it is marked ready: no step tasted the change.`, or `A person reviews this before it is marked ready: a Taster asks for changes (<steps>); its findings are in the reports below.`
- `PullRequestRequest` carries `draft`, and `githubPullRequests` sends it in the `POST`. When GitHub refuses a draft because the repository cannot have one (a private repository on GitHub Free answers 422 and says so), the open is asked again once without it, with the same body: its line says a person reviews it before it is marked ready, which holds either way. Any other refusal fails the effect, as before.
- **The engine marks nothing ready later**: a person does.

### Trust boundaries
- A row for model text the engine posts on GitHub, owned by the engine's frame: the fenced reports, and the filters on the unfenced sections (`docs/trust-boundaries.md`).

## Consequences
- A brewed pull request reads like one a person opened in Foedrum's own layout: how it works with its picture, before and after, **See it**, how it was brewed, the reports folded away, and `Closes`.
- Nip opens ready when its `diff/correctness` Taster approves, and as a draft when it asks for changes. A Brewery recipe without a lens step always opens drafts.
- The Cellarman writes about 300 more words per batch in its out doc, in the run it already makes. One that leaves the sections out opens a pull request without them.
- Model text that names `@types/node` shows `types/node`, and `Fixes #3` shows `#3`: the cost of reading the text as GitHub would without a Markdown parser. A mention or a keyword inside a code span is removed too, and `&amp;` in a code span shows as written. A line of `howItWorks` that starts with an HTML tag shows the tag as text.
- A model can still write a heading or a line that looks like the engine's (`## How this was brewed`). It changes no state: the draft flag and the `Closes` line are the engine's.
- Brewery Cellarmen of their own keep `outDoc` and open pull requests without the sections until they move to `pullRequest`.

## Alternatives considered
- **A brewer step that writes the whole description.** Model text would be the frame: its `Closes` line, its mentions and its claim to be reviewed. One more brewer run per batch.
- **A template per repository in the Brewery, or the repository's `.github/pull_request_template.md`.** It waits until someone asks for it; one layout serves Foedrum's own rules and reads well elsewhere.
- **Fence the sections too.** Nothing would link or ping, but a Mermaid picture and a table in a `text` fence render as plain text.
- **Strip with a Markdown parser, keeping code spans as written.** A dependency, or a parser of our own, for a few characters of prose; the filter fails closed instead.
- **Fail the open when GitHub refuses a draft.** The batch would sit until its deadline and go Stuck, and a person would open the same pull request by hand.
- **Mark the pull request ready once a later review approves.** The engine would act on GitHub after the batch is on tap; a person marks it ready.
- **Cut the sections short in the engine instead of limiting them in the schema.** A cut in the middle of a Mermaid block breaks the picture.
- **Require `howItWorks` and `seeIt` on a `done`.** Every brewed pull request would have them, but a Cellarman that forgot one would run again from the start.
