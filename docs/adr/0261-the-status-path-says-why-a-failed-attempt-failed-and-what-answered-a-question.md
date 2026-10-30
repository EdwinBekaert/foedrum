# 0261. The status Path says why a failed attempt failed and what answered a question

Date: 2026-10-30 · Status: Accepted · Amends [0154](0154-lane-labels-on-the-order-s-issue-and-the-status-comment-s-path-line.md) (what follows an attempt's mark on the path line) and [0123](0123-foedrum-brew-drives-one-batch-under-an-owner-of-its-own.md) (what `foedrum brew` prints last on tap without a pull request)

## Context
The status comment's path line marks each attempt as the step list marks it, and nothing more ([ADR 0154](0154-lane-labels-on-the-order-s-issue-and-the-status-comment-s-path-line.md)).
The maintainer's `foedrum mash` run and `npm run demo` showed three misreadings (#656):
- An answered question kept its ❓: `innkeep #1 ❓ → plan #1 ❌ → plan #2 ✅` read as if the question were still open, and the step line still said "asked for input". The answer was in the ledger, and only `foedrum replay` showed it.
- Every ❌ looked alike: in the demo, a lost lease (`gauge #1`), a failing check (`green #1`) and a review's findings (`correctness #1`) were the same mark, so a retry after a form error read as a failed plan.
- `foedrum brew` ended a batch on tap with no pull request as `batch 12-1 is on tap:`, with nothing after the colon.

## Decision

### An answered question
- The fold records on each of a step's inputs the attempt it answers: the step's latest attempt when `input.received` is folded. An answer comes only while the batch is Stuck on that attempt's questions. This is state only; no event gains a field.
- On the path, an attempt that asked and was answered keeps its ❓, followed by `→ <answer> (by <who> via <surface>)`, for example `` `innkeep #1` ❓ → mash (by ann via terminal) ``. The answers are joined with `, ` and cut to 40 characters, and only the attempt's latest answer is shown. `by` is the login or driver name already shown in "chosen by" lines.
- The step line of a step whose latest attempt was answered (the recipe choice, which schedules no further attempt of that step) says `attempt <n> asked for input, answered by <who> (<surface>): <answer>`.
- An open question keeps its bare ❓, or 🔔 where the batch is Stuck on it.

### Why a failed attempt failed
- On the path, each ❌ is followed by the failed outcome's reason: its first clause, the text before the first `: `, which is where the engine names the class of a failure (`the attempt was lost`, `blocked (findings)`).
- A clause longer than 48 characters loses its parenthesised parts (a check's command), and is then cut at a word, with `…`.
- The secret scan reads the whole reason before it is cut, as for every text a brewer wrote ([ADR 0088](0088-out-doc-text-that-looks-like-a-secret-is-left-out-of-the-pull-request-and-the-status-comment.md)).
- A 🔔 stays bare: the Stuck line already says why.

The path still changes only at an attempt's start or end, or a lane change (an answer resumes a Stuck batch), so the comment's revisions stay within one a minute ([ADR 0072](0072-the-status-comment-edits-as-revisions-in-the-ledger.md)).

### `foedrum brew` on tap without a pull request
Its last line says `no pull request`, followed by `; the plan: <link>` to the plan comment when the order has one: the batch's own revision of it, else the one an earlier batch of the order made ([ADR 0233](0233-a-plan-is-an-out-doc-whose-paths-the-engine-checks-shown-as-one-comment-per-order.md)).

Rejected:
- A fixed phrase per class of failure ("out doc invalid", "red proof", "lost"). The reasons come from about twenty places as free text, and a table would drift from them; the engine already starts each reason with its class.
- Matching answers to attempts by counting a step's needs_input attempts. It goes wrong when a question is retried, rewound or skipped instead of answered.
- A new field on `input.received`. The fold already knows the attempt.

## Consequences
- The path line grows by up to about 50 characters per failed attempt and per answered question. A long batch's line is longer, and still one line.
- A reason that does not start with its class shows its first words instead, cut at a word.
- `Input` in the fold gains `attempt`.
