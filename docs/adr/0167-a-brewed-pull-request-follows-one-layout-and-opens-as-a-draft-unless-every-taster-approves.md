# 0167. A brewed pull request follows one layout, and opens as a draft unless every Taster approves

Date: 2026-10-24 · Status: Accepted · Amends [0071](0071-the-openpullrequest-action-two-effects-of-the-batch.md) (the pull request's body and whether it is a draft) and [0088](0088-out-doc-text-that-looks-like-a-secret-is-left-out-of-the-pull-request-and-the-status-comment.md) (the body reads its new sections for secrets, and holds its reports to 28,000 characters)

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
- **A brewer whose out doc schema is `pullRequest`** (`output.schema`) writes the pull request's sections, as a Taster is one whose schema is `tasting` ([ADR 0161](0161-lens-steps-run-a-taster-whose-findings-are-advisory-unless-the-step-blocks.md)). Its out doc adds three fields to the contract (`PullRequestOutDoc`, `src/schemas/out-doc.ts`), and a `done` must have the first two:
  - `howItWorks`: Markdown, at most 10,000 characters, which part of the repository the change touches and what it does, with one Mermaid picture where the change has a shape;
  - `seeIt`: one line of at most 1,000 characters, how a person sees the change work;
  - `beforeAfter`: optional, at most 20 rows of `{ "case", "before", "after" }`, each one line of at most 300 characters, which the engine renders as a table, so the model writes no table syntax.
- **The default Cellarman answers with `pullRequest`** (`defaults/brewers/cellarman.md`, version 4), and its prompt says what each field holds. No extra brewer run.
- The limits keep the body under GitHub's 65,536 characters without cutting Markdown in the middle: an out doc past them is invalid, and its attempt is tried again with the reason.

### The engine builds the body
- **One fixed layout**, for every target repository (`pullRequestText`, `src/engine/pull-request.ts`):
  1. `## How it works`, then `howItWorks`, then the before/after table when there is one, then `**See it:** <seeIt>`, from the latest out doc of the batch that has them (the step scheduled last, its latest attempt that succeeded). A batch with none (a recipe without such a brewer) has no such section.
  2. `## How this was brewed`: `Brewed by Foedrum from <owner/name>#<n> with the recipe <name>.`, a line that says why the pull request is a draft or ready, and a table of every finished attempt in the order the attempts started (`Batch.path`): `<step> #<n>` and its result in the engine's words only (`succeeded`, a Taster's `approve` or `changes`, `failed`, `needs input`, `cancelled`, `abandoned`), at most 100 rows and a count of the rest. The action's own attempt is still running and is not listed.
  3. The step reports, as ADR 0071 and ADR 0161 quote them, in their fenced `text` block, folded in `<details><summary>What each step reported</summary>`.
  4. `Closes <owner/name>#<n>`, the order's issue, which the engine writes itself.
- **The model's sections go through two filters**, in this order:
  - **Secrets** ([ADR 0088](0088-out-doc-text-that-looks-like-a-secret-is-left-out-of-the-pull-request-and-the-status-comment.md)): `howItWorks`, `seeIt` and each table cell is read whole with `withoutSecrets`, and a match leaves that whole text out, with the fixed line naming its step in its place.
  - **The frame** (`unlinked`, `src/engine/pull-request.ts`): the text is not fenced, so GitHub would read it. An `@` that starts a mention (at the start, or after anything but a letter, digit, `_` or `` ` ``, before a letter or digit) is removed, so nobody is pinged. A closing keyword (`close`, `closes`, `closed`, `fix`, `fixes`, `fixed`, `resolve`, `resolves`, `resolved`, any case) followed, after anything but letters and digits or a named HTML entity, by an issue reference (`#`, `GH-`, `owner/name#`, a URL) is removed, again until none is left, so `closes closes #3` does not leave a `closes #3`. Every `&#` becomes `&amp;#`, so a keyword or an `@` spelled with a numeric character reference stays text. The reference itself stays and links, and closes nothing.
  - A table cell also has its `|` escaped and its backslashes doubled, so a cell stays a cell.
- **The step reports fit in 28,000 characters**, where ADR 0088 gave them 60,000, since the sections take the rest. They are read up to 29,000, by ADR 0088's rule, and cut short there, saying so.

### Draft or ready by the Tasters' verdicts
- **The pull request opens ready only when a Taster tasted the change and every Taster approved**: at least one step report has a Taster's verdict, and every verdict is `approve`. Otherwise it opens as a draft: when no step tasted it (the recipe has no lens step, or its `when` skipped them), or when a Taster's verdict is `changes`, whose findings are already listed among the reports (ADR 0161). A blocking Taster's `changes` sends the batch back before this (ADR 0161), so only an advisory one reaches the pull request.
- The body's line says which: `Opened ready for review: every Taster approved.`, `Opened as a draft: no step tasted the change, so a person reviews it before it is marked ready.`, or `Opened as a draft: a Taster asks for changes (<steps>); its findings are in the reports below.`
- `PullRequestRequest` carries `draft`, and `githubPullRequests` sends it in the `POST`. When GitHub refuses a draft because the repository cannot have one (a private repository on GitHub Free answers 422 and says so), the open is asked again once without it; the body's line already says a person reviews it first, so a pull request opened ready that way still says so.
- **The engine marks nothing ready later**: a person does.

### Trust boundaries
- A row for model text the engine posts on GitHub, owned by the engine's frame: the fenced reports, and the filters on the unfenced sections (`docs/trust-boundaries.md`).

## Consequences
- A brewed pull request reads like one a person opened in Foedrum's own layout: how it works with its picture, before and after, **See it**, how it was brewed, the reports folded away, and `Closes`.
- Nip opens ready when its `diff/correctness` Taster approves, and as a draft when it asks for changes. A Brewery recipe without a lens step always opens drafts.
- The Cellarman writes about 300 more words per batch in its out doc, in the run it already makes. A Cellarman out doc without `howItWorks` or `seeIt` fails its attempt, which costs a retry.
- Model text that names `@types/node` shows `types/node`, and `Fixes #3` shows `#3`: the cost of reading the text as GitHub would without a Markdown parser. A mention or a keyword inside a code span is removed too.
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
