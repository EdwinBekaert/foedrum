# What a batch is to a person

The engine moves a batch through its lanes ([batch lifecycle](../engine/lifecycle.md)); a person reads one of four states instead, which one function works out and every surface renders ([ADR 0379](../../adr/0379-what-foedrum-writes-for-a-person-reads-in-plain-words-and-every-surface-shows-one-state.md)).
The lanes (`on_tap`, `stuck`, …) stay inside the engine: every decision it makes still reads them.

## The four states

`batchState` (`src/engine/batch-state.ts`) says what a batch is to a person, and `stateOf` reads what it needs from the store: whether a person's pause holds it, whether a closed usage window holds its brewers, and for a split order its sub-orders' latest batches.

| State | When | Label |
|---|---|---|
| **Running** | A brewer or a check works on it now: brewing, not paused, and not held, with nothing running, by the usage window of every brewer (a family's window holds only its own brewers, [ADR 0215](../../adr/0215-an-opus-or-sonnet-limit-holds-only-the-brewers-of-its-family.md)) | `foedrum:running` |
| **Waiting for you**: approve the plan | Stuck as `plan_review` | `foedrum:approve-plan` |
| **Waiting for you**: answer a question | Stuck as `needs_input`, or as `order_changed` ([ADR 0368](../../adr/0368-an-issue-changed-after-its-approval-asks-the-engineer-whether-to-continue.md)) | `foedrum:answer` |
| **Waiting for you**: review and merge the pull request | On tap with a pull request not merged or closed | `foedrum:review-and-merge` |
| **Waiting for you**: open its session | Stuck as `waiting_for_session` ([interactive steps](../recipes/interactive-steps.md)) | `foedrum:open-session` |
| **Waiting for you**: choose a recipe | Stuck as `routing` | `foedrum:choose-recipe` |
| **Waiting for you**: look at a failure Foedrum could not get past | Stuck for any other reason, one a newer Foedrum records among them | `foedrum:look-at-failure` |
| **Queued** | Waiting for a recipe (ordered); for a merge, a release or another batch (conditioning); paused by a person ([pause and continue](pause.md)); held by a usage limit with nothing running ([the usage window](../engine/usage-window.md)); or an approved plan whose sub-orders are not opened yet | `foedrum:queued` |
| **Done** | Merged, closed without merging, cancelled, or finished with no pull request | none |

Done is the engine's own rule, `batchEnded`, and `orderEnd` for a split order ([ADR 0293](../../adr/0293-a-split-order-ends-once-every-sub-order-merged-and-the-engine-closes-it.md)), plus a recipe that ended with no pull request; when #921 lands, `batchEnded` will take that last case too.
A split order, an approved plan on tap with no pull request of its own, takes its sub-orders' most pressing state, waiting before running before queued, the first in merge order of those as pressing, and names that sub-order (`Running: sub-order #12`).
A sub-order that keeps the order open (cancelled, closed without merging, needs refinement) waits for you to look at it, and one with no batch yet is queued: it is not ordered yet.

## The words

`stateLine` gives the state as one line (`Waiting for you: approve the plan`, `Queued: waiting for the merge of <url>`, `Done: merged`), and `stateClause` the same as the end of a sentence (`#3 is waiting for you: approve the plan`).
Every surface renders that one answer: `foedrum status`'s state column, `foedrum stuck`, `foedrum brew`, `replay`'s `state` line, `resume`, the line every command that changes a batch prints, the status comment's first line, the plan comment and the label.
The status comment starts that line with a mark per state: 🍺 running, 🔔 waiting for you, ⏳ queued, 🍻 done ([on GitHub](github.md)).

## The labels

A Brewery issue carries one label at a time, its latest batch's state from the table above (`LaneLabelName`, `src/schemas/lane-label.ts`), and none once done; how a label is put on and taken off is on [GitHub](github.md).
The labels an older Foedrum set (`foedrum:on-tap`, `foedrum:ordered`, `foedrum:brewing`, `foedrum:conditioning`, `foedrum:awaiting-approval`, `foedrum:awaiting-answer`, `foedrum:stuck`, `foedrum:awaiting-merge`, `foedrum:sub-orders`) are `RetiredLaneLabel`, which a revision still takes off.

## The Next line

A batch Stuck for any reason has one `Next:` line, `stuckNext` (`src/engine/next-step.ts`), the same in the status comment, the plan comment, `foedrum stuck`, `foedrum brew` and `foedrum stop`.
The status comment and the plan comment write each command as code, a terminal as it is.
Each option of its lane is said as what it does and its whole command:

- `approve`: sign it off with `foedrum approve 7`;
- `lauter`: correct it with the Brewmaster, the brewer that plans, in a session with `foedrum lauter 7`;
- `retry`: plan it again (`plan_review`), route it again by its labels (`routing`), or else try the step again, with `foedrum retry 7`;
- `skip`: go past the step with `foedrum skip 7`;
- `recipe`: brew the issue with another recipe with `foedrum recipe 7 <recipe> <reason>`;
- `rewind`: take it back to an earlier step with `foedrum rewind 7 <step>`;
- `cancel`: end it with `foedrum cancel 7`.

A command names the issue's number for its latest batch, and the batch's id for an older one (`calledAs`, [ADR 0334](../../adr/0334-every-line-names-the-number-and-the-innkeeper-reads-it-from-its-input-s-source.md)).
The line starts by the reason:

- `plan_review`: `Next: read the plan and its assumptions, then` its options;
- `needs_input`: `answer the questions above with foedrum answer 7 <answer 1> <answer 2>`, or its other options;
- `order_changed`: `answer foedrum answer 7 continue to brew the issue as it is now, or foedrum answer 7 stop to end the batch`;
- `waiting_for_session`: `open its session with foedrum brew 7 --take in a terminal`, or its other options;
- `routing`: `choose a recipe with foedrum recipe 7 <recipe> <reason>`, or its other options;
- `stopped`: `when it should go on,` its options ([pause, continue and stop](pause.md));
- any other: `look at what failed above, then` its options.

A batch that waits for the review of its pull request has the status comment's own `Next:` line, which follows the merge brief ([on GitHub](github.md)), and in `foedrum stuck` `Next: review and merge <url>.`; a split order that waits through one of its sub-orders says `Next: see #<n>, whose own comment says what to do.`

## Other plain words

- A time reads `13 Nov 19:16 UTC` wherever a person reads one (`whenText`, `src/engine/when.ts`); events keep the ISO form.
- An attempt reads `step plan`, and `step plan (try 2)` from its second try on (`attemptName`, `src/engine/words.ts`); a path, a table or a receipt names it short, `plan (try 2)` (`tryName`).
- Where a command came from reads `from a terminal`, `from Claude Code`, `in a comment` or `from the dashboard` (`surfaceText`).
- Why a blocked step could not go on reads as what its blocker kind means: the review found problems that are still open, something it needs outside the change is missing, or the work went a way the recipe did not expect (`blockerText`).
- A finding reads its `point` first, then in parentheses its lens, severity, place and whether it was there before the change: `<point> (<lens>, <severity> in <file>:<line>)` (`findingText`, [tasting](../recipes/tasting.md)).
- In the status comment, the merge brief and the plan comment, `!` is not escaped, and an `@` before a login's character starts a code span around the word (`` `@demo/greet` ``) in place of an entity: GitHub mentions no one inside a code span ([ADR 0072](../../adr/0072-the-status-comment-edits-as-revisions-in-the-ledger.md)); every other escape stays.
