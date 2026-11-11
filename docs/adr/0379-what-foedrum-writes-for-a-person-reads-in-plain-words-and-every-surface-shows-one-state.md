# 0379. What Foedrum writes for a person reads in plain words, and every surface shows one state

Date: 2026-11-11 · Status: Accepted · Amends [0316](0316-a-brewery-issue-s-label-and-status-comment-name-the-person-s-next-action.md) and [0154](0154-lane-labels-on-the-order-s-issue-and-the-status-comment-s-path-line.md) (the labels name the state a person reads, not the lane), [0072](0072-the-status-comment-edits-as-revisions-in-the-ledger.md) (`!` is no longer escaped, and an `@`-word is a code span, not `&#64;`), [0161](0161-lens-steps-run-a-taster-whose-findings-are-advisory-unless-the-step-blocks.md) (a finding has a required `point`), [0334](0334-every-line-names-the-number-and-the-innkeeper-reads-it-from-its-input-s-source.md) (every option of a `Next:` line is its whole command, also for the latest batch), [0005](0005-typed-step-outcomes-and-out-docs.md) and [0308](0308-a-taster-reads-the-checks-that-ran-on-its-head-and-an-out-doc-claims-only-what-its-session-did.md) (the out doc contract asks for plain words, within 1,500 characters), and [0172](0172-an-attempt-s-receipt-from-its-stream.md), [0174](0174-foedrum-brew-keeps-a-live-line-on-a-terminal.md), [0181](0181-receipts-show-no-cost.md), [0184](0184-a-brewed-pull-request-keeps-what-a-code-span-holds-and-writes-each-attempt-as-one.md) and [0346](0346-the-live-line-runs-from-a-brew-s-first-second-to-its-last-with-gh-s-moving-mark.md) (an attempt reads `step plan`, then `step plan (try 2)`, where they quote `plan #2`), and [0261](0261-the-status-path-says-why-a-failed-attempt-failed-and-what-answered-a-question.md) (where an answer came from reads `from a terminal`), [0350](0350-a-brewed-pull-request-is-a-draft-until-its-merge-brief-and-the-next-line-follows-the-brief.md) and [0355](0355-a-recipe-choice-and-a-brew-s-start-show-on-the-brewery-issue-at-once.md) (the labels they name are now `foedrum:review-and-merge` and `foedrum:running`), and [0206](0206-a-run-out-usage-window-holds-every-brewer-attempt-until-it-reopens.md) and [0215](0215-an-opus-or-sonnet-limit-holds-only-the-brewers-of-its-family.md) (the usage window's line ends `13 Nov 19:16 UTC`, and only the window of every brewer holds a batch between steps)

## Context
What Foedrum wrote for a person often read as a record for the engine (#927).
A finding led with its severity, file, line, rule and decision number, and its point came last, if at all; the maintainer read one from #924's reports and could not tell what it meant.
Times read `2026-11-13T19:16:04.284Z`; an attempt read `plan #2`, like an issue number; a batch read `on tap`, `Stuck` or `conditioning`, the engine's lanes.
Each surface also worked out a batch's state on its own (#834): `on_tap` or `stuck` appeared in 33 files of `src`.
`npm run demo -- ladder` showed the result: a finished order read `on tap` in `foedrum status` and Done in its comment, and a plan waiting for its review read Stuck in the comment, `foedrum status` and `foedrum stuck` while its label said `foedrum:awaiting-approval`.
Escapes meant for GitHub's parser, `&#64;` and `\!`, reached a person wherever the Markdown is read as it is: the demo, `gh issue view` on a terminal.

## Decision
- **Four states, one function.** `batchState` (`src/engine/batch-state.ts`) says what a batch is to a person, and `stateOf` reads what it needs from the store:
  - **Running**: a brewer or a check works on it now (brewing, not paused, and not held, with nothing running, by the usage window of every brewer).
  - **Waiting for you**, and for what: approve the plan (`plan_review`), answer a question (`needs_input`, `order_changed`), review and merge the pull request (on tap with one open), open its session (`waiting_for_session`), choose a recipe (`routing`), or look at a failure Foedrum could not get past (every other Stuck reason, one a newer Foedrum records among them).
  - **Queued**: waiting for a recipe (ordered), for a merge, a release or another batch (conditioning), paused by a person, held by the usage window of every brewer (a family's window holds only its own brewers, ADR 0215), or an approved plan whose sub-orders are not opened yet.
  - **Done**, and how: merged, closed without merging, cancelled, or finished with no pull request.
    Done is the engine's own rule, `batchEnded`, and `orderEnd` for a split order, plus a recipe that ended with no pull request; one rule, not two; when #921 lands, `batchEnded` will take that last case too.
  - A split order takes its sub-orders' most pressing state, waiting before running before queued, naming the sub-order; a sub-order that keeps the order open (cancelled, closed without merging, needs refinement) waits for you to look at it.
  The lanes (`on_tap`, `stuck`, …) stay inside the engine, unchanged: every decision the engine makes still reads them.
- **Every surface renders that one answer**: `foedrum status`, `foedrum stuck`, `foedrum brew`, `replay`, `resume`, the line every command that changes a batch prints, the status comment, the plan comment and the label.
  `stateLine` gives the words (`Waiting for you: approve the plan`), `stateClause` the same as the end of a sentence (`#3 is waiting for you: approve the plan`).
- **The labels are the states** (`LaneLabelName`): `foedrum:queued`, `foedrum:running`, `foedrum:approve-plan`, `foedrum:answer`, `foedrum:review-and-merge`, `foedrum:open-session`, `foedrum:choose-recipe` and `foedrum:look-at-failure`; none once done.
  The old names join `RetiredLaneLabel`, which a revision still takes off.
- **One `Next:` line** for a batch that waits for you, `stuckNext` (`src/engine/next-step.ts`), in the status comment, the plan comment, `foedrum stuck`, `foedrum brew` and `foedrum stop`.
  Each option of its lane is said as what it does and its whole command (`try the step again with foedrum retry 7`), also for the latest batch, whose number the command takes; an older batch's command takes its id (ADR 0334).
- **`foedrum stuck` lists every batch that waits for you**, a pull request waiting for its review among them, each with its `Next:` line; its `options:` and `run as:` lines are gone.
- **A finding has a `point`** (`TastingFinding`): one line of at most 160 characters, cut with a mark past it as `riskLeft` is, saying in plain words what goes wrong and what to change.
  `findingText` shows it first, then in parentheses its lens, severity, place and whether it was there before; every surface that shows a finding goes through it.
  `why` stays the evidence for the brewer who fixes it, and the brewer-facing route input keeps its form.
  A schema field, not the prompts alone: only a field guarantees a short first line on every finding, and the renderer puts it first whatever the model writes; whether it is plain is up to the prompt, which no test judges.
  A blocking Brett step's survivor gets a fixed point.
- **Times read `13 Nov 19:16 UTC`** (`whenText`, `src/engine/when.ts`) wherever a person reads one; events keep the ISO form.
- **An attempt reads `step plan`**, and `step plan (try 2)` from its second try on (`attemptName`, `tryName`, `src/engine/words.ts`); where a command came from reads `from a terminal`, `from Claude Code`, `in a comment`.
- **Escapes stay for the parser only.** In the status comment, the merge brief and the plan comment (`plainWithin`), `!` is no longer escaped: an image needs a `[` after it, which stays escaped.
  An `@` before a login's character starts a code span around the word (`` `@demo/greet` ``), in place of `&#64;`: GitHub mentions no one inside a code span, and the raw text reads as the rendered one.
  Every other escape stays: GitHub shows `\_` as `_`.
- **Right the first time, no extra reviewer.** Every default brewer and lens that writes text a person reads asks for plain words: what happened, why it matters, what to do, before any file, line, rule or decision number.
  The out doc contract asks it of every brewer's `summary`, `assumptions` and questions, and so grows past 1,400 characters to at most 1,500.
  No lens judges the words afterwards, and no test does: that would spend tokens twice.
- **Model text stays untrusted.** A `point` passes the same filters as `why` (ADR 0088's secrets, ADR 0072's escaping), and the prompts change nothing of the nonce tags (ADR 0041).

## Consequences
- A person reads the same state everywhere, in words that need no engine.
- Brewery migration: none. Foedrum has no release; a Brewery's own brewer or lens file that replaces a default keeps its own text, and no code reads the old label names.
- Lenses carry no `version`; the Taster's prompt, which every lens runs under, raised its.
