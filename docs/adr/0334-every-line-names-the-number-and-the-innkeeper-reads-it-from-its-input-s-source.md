# 0334. Every line names the number, and the Innkeeper reads it from its input's source

Date: 2026-11-06 · Status: Accepted · Amends [0329](0329-one-number-per-piece-of-work.md) (the rest of its rule, with one exception) and [0232](0232-foedrum-mash-routes-an-issue-to-the-innkeeper-whose-question-the-answer-chooses-the-recipe-by.md) (which number the Innkeeper's question names), [0240](0240-order-and-recipe-work-by-the-brewery-issue-on-both-surfaces.md) (the words of `recipe`'s lines) [0281](0281-foedrum-approve-signs-off-a-plan-by-its-hash-and-puts-the-batch-on-tap.md) (the plan comment's `Waiting for` line), [0105](0105-foedrum-order-orders-an-issue-again-as-a-human-command-recorded-on-batch-ordered.md) (the words of `order`'s refusal), [0123](0123-foedrum-brew-drives-one-batch-under-an-owner-of-its-own.md) (the `foedrum answer` line), [0124](0124-foedrum-takeover-hands-a-batch-to-another-driver-as-a-recorded-command.md) (the words of `takeover`'s refusal), [0286](0286-foedrum-lauter-corrects-a-plan-at-gate-1-in-an-interactive-session.md) (the plan's next step) and [0316](0316-a-brewery-issue-s-label-and-status-comment-name-the-person-s-next-action.md) (the `Next:` line for questions)

## Context
[ADR 0329](0329-one-number-per-piece-of-work.md) made every command take the Brewery issue's number and left "every other line" to #881: lines that still named a batch id, and the Innkeeper's question, which said `#864` on Brewery issue #19 because the model took the number from the order.
Two things were not settled there: how the Innkeeper is given the number, and what a line says about a batch the number does not reach.

## Decision

### The Innkeeper reads the number from its input's source
- **The `order` input's `source` attribute names the Brewery issue of a claimed order:** `issue #864 body, the order on Brewery issue #19`.
  A Brewery issue's own batch keeps `issue #19 body`, and so does a claimed batch before its Brewery issue opens, when no number exists yet.
- **`innkeeper.md` says which number to use:** the Brewery issue the source of `{order}` names, or else its issue, never a number from the order's text.
  Its `version` goes up to 4.
- The engine writes that attribute, so an order's text cannot change it.
- Every brewer with an `order` input reads the same attribute; only the Innkeeper's prompt uses it now.

### A line says the number
- **Prose says `#19`, and a command says the bare `19`** (`saidAs`, `calledAs` in `src/engine/claim-orders.ts`); before the Brewery issue opens both say `foedrum#864`, the only form there is.
- This covers `foedrum brew`, `mash`, `lauter`, `resume` and `takeover`, the line of every command that changes a batch, the status comment's and plan comment's `Next:` and `Waiting for` lines, `foedrum stuck`'s `next:`, and the refusals that name an order (`orderSaid`).
  `decide` has no alias map, so such a refusal names a target issue with no live Brewery issue as `<owner>/<name>#<n>`.

### The one exception: a batch the number would not reach
- **A batch that is not its issue's latest is offered by its id.**
  A number means the latest batch ([ADR 0329](0329-one-number-per-piece-of-work.md)), so `foedrum resume 19 plan#1`, printed for an older batch, would open another batch's session.
  This is the only line that suggests a batch id.
- **An older batch can be Stuck.**
  A batch on tap counts as ended, so a later batch of its issue can be ordered, and a failed pull request can then bring the earlier one back to brewing and to a question (`fix_pull_request`).
  Its `foedrum answer`, `approve`, `lauter`, `retry` and `cancel` lines, in `foedrum stuck` and in both comments, say its id, which those commands take.
- **`brew` takes no batch id, and this does not change that.**
  `foedrum takeover` of an older batch that no driver holds says so and offers no command.
  An older batch waiting for a session has no command that opens it, as it had none before: its status comment offers the number, which reaches the latest batch, and `foedrum status` and `stuck` offer its id, which `brew` refuses at once.
  That needs a recipe whose pull-request route passes through an interactive step, and the gap is older than this record.

### What keeps the batch id, offering no command
- The headings of the status comment and the plan comment, and the footers of sub-issues and merge briefs: each batch has its own, and several batches of one issue differ by it, as with `foedrum status`'s columns.
- `foedrum serve`'s driver notices (`formatNotice`), which are the engine's log over many batches, and the `sibling` wait.
- The generic refusals of `admit.ts` and `decide.ts` (`batch 7-1 is on_tap; retry needs it stuck`), and `foedrum resume`'s refusals about an attempt, none of which offers a command with an argument.

### What goes back to the target stays the target's
The claim comment and the pull request name the target issue, and never a bare Brewery number: on the target, `#19` would link that repository's own issue 19.

## Consequences
- **No file in a Brewery has to change for Foedrum to run.**
  A Brewery with its own copy of `brewers/innkeeper.md` changes one line, or its questions keep naming the target number:
  `` - `"q"`: `Which recipe brews #<n>? Suggested: <recipe>: <the reason, in one sentence>`, where `<n>` is the Brewery issue the source of {order} names, or else its issue, never a number from the order's text; ``
- No event changes, and a running batch keeps working: every command still takes a batch id.
- A status or plan comment waiting on a person gets one more revision for its new words.
- A script that read the batch id from `foedrum brew`'s `answer them in order …` line now reads the number, which `foedrum answer` takes. `/foedrum:brew` and `/foedrum:mash` keep their strict check of that word's shape.
- A person who gave a batch id gets its number back in the line, unless that batch is not the latest.

## Alternatives considered
- **A new input, `from: "order-number"`:** explicit, but a Brewery's own copy would change its frontmatter as well as its line, and it adds a kind to the brewer schema for one number.
- **The engine writes the question's number itself:** no model involved, but the question is the model's text, and rewriting it is a second reading of a free-form field.
- **Always the number, for older batches too:** no exception, but the line would run on another batch.
- **Rename the generic refusals too:** one more rule kept everywhere, for words that offer nothing, across some forty assertions on the engine's rejections.
