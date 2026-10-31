# 0275. A finished plan waits Stuck for its review, and every comment links the doc it sums up

Date: 2026-10-31 · Status: Accepted · Amends [0234](0234-the-brewmaster-writes-a-plan-on-the-planner-alias-and-mash-runs-it.md) (a `mash` batch ends Stuck, not on tap), [0233](0233-a-plan-is-an-out-doc-whose-paths-the-engine-checks-shown-as-one-comment-per-order.md) (the plan comment's layout and cut, and a plan's out doc has a body the engine checks), [0266](0266-the-plan-and-status-comments-link-the-plan-s-out-doc-on-the-state-branch.md) (where the links go, and which view they open), [0059](0059-attempt-plans-from-the-brewer-of-the-step.md) and [0084](0084-a-batch-s-commits-end-in-a-pull-request-or-on-a-kept-branch.md) (a recipe done without a pull request goes on tap unless it ends with a plan), [0072](0072-the-status-comment-edits-as-revisions-in-the-ledger.md) (what the status comment shows of a plan's assumptions), [0261](0261-the-status-path-says-why-a-failed-attempt-failed-and-what-answered-a-question.md) (`foedrum brew` names the plan comment on its Stuck line, not on tap) and [0025](0025-batch-lifecycle-stuck-reminders-and-rewind.md) (a Stuck reason that offers fewer options)

## Context
A `mash` run on the maintainer's Brewery (batch 12-1, #658) showed how a finished plan reads.
- The status comment said **🍻 On tap**, the glossary's lane for a recipe done without a pull request (ADR 0059, ADR 0084, ADR 0234). Nothing was ready to pour: the plan waits for a review (#587) and a sign-off (#588), neither built. `foedrum stuck` did not list it.
- The status comment cut each assumption at about 200 characters. The full text was in the out doc ADR 0266 links, but in its JSON frontmatter, which GitHub's rendered view does not show readably, so the link opened `?plain=1`.
- The plan comment's table had eight columns; one cell held 13 paths, another a sentence of why.
- Neither comment said what to do next.

The maintainer decided on #658 (2026-10-31): a finished plan nobody has reviewed waits Stuck with a reason of its own; a comment that shows part of a document the engineer can open links it and sums it up; and the plan comment is laid out for review.

## Decision

### A plan waits Stuck for its review
- **A new Stuck reason, `plan_review`**, with the step and attempt whose plan it is (`StuckReason`, `src/schemas/events.ts`).
- **The decider sticks a batch with it in place of on tap**: when its recipe is done with no pull request and an attempt of a step of that recipe succeeded with a plan, the latest one (`continueAfter`, `src/engine/decide.ts`; `latestPlan`, `src/engine/plan-comment.ts`). A plan of a recipe a person moved the batch away from does not count. A recipe with the openPullRequest action still goes on tap with its pull request (ADR 0071), and one with neither a plan nor a pull request still goes on tap (ADR 0059).
- **It offers `retry`, `recipe` and `cancel`.** A retry plans again in an attempt of its own, not as a retry of the plan before it: that one succeeded, and a retry would resume its session told it ended before it was done (ADR 0248). `skip` and `rewind` are not offered: either ends the recipe on the same plan, which would stick again. Nothing new ends it: a person cancels it, then orders the issue again when they want.
- **#588's gate adds `approve` to the same reason**, and its `foedrum approve` replaces the next step below.
- **It is shown everywhere a Stuck batch is**: `foedrum stuck` and the board say `the plan of <step> #<n> is ready for your review`, and `foedrum stuck` adds the next step; the status comment's lane says it with the plan comment's link and the next step; `foedrum brew` ends Stuck (exit 3), its last line naming the plan comment as its on tap line did (#656).
- **The next step, until #588 and #590**: `read the plan and its assumptions. To plan it again, run foedrum retry <batch>; to build it, end it with foedrum cancel <batch> and order its sub-orders by hand: Foedrum builds nothing from a plan yet.` One function says it for the three readers (`planNextStep`, `src/engine/status-comment.ts`).
- **The status comment's step line and path do not mark the plan step Stuck**: its attempt succeeded, and the lane says why the batch waits.
- **A recorded batch is not changed.** The fold is not: a batch that went on tap with a plan before this, as 12-1, stays on tap on replay, with ADR 0234's line that nothing is built from its plan. Only a decision made after this ships sticks. An older Foedrum cannot read a `plan_review` event.

Rejected: a lane of its own (a plan that waits for a person is what Stuck means, and #588's gate waits Stuck too); leaving it on tap with a line that it waits (On tap is the lane of a done recipe, and `foedrum stuck` would still not list it); offering `skip` (it would stick again at once).

### A comment links every doc it sums up
- **The rule**: a comment that shows part of a document the engineer can open links that document, and shows a summary of it, not a copy.
- **The plan's out doc reads on GitHub.** Its body starts with the plan's summary and lists each assumption as an item of its own line, word for word, and the engine checks it: a `done` plan whose body does not hold the summary, or an assumption as a list item (blanks collapsed, `-`, `*`, `+` or a number before it), fails the attempt retryably, naming the first assumption missing by its index (`unreadableBody`, `src/schemas/plan.ts`; `readableBody` in `AttemptLimits`, set for the `plan` schema). The Brewmaster's prompt asks for it.
  Since its body reads, its link opens GitHub's rendered view, not `?plain=1` (`outDocLink(…, readable)`, `src/engine/state-branch.ts`).
- **Every step's out doc is linked**: the status comment's line of a step whose latest attempt succeeded with an out doc (not a check step or an action such as openPullRequest, which write none; every out doc has its assumptions) ends with `out doc:` and its link, a plan's rendered, any other's `?plain=1`. The plain view is the interim for an out doc with no readable body, whose frontmatter only reads there; a schema whose body the engine checks moves to the rendered view as the plan's did.
- **A plan's assumptions are summed up**: one line each in the status comment, its first sentence (to a `.`, `!` or `?` before a blank or the end), cut at the last word within 120 characters with `…`; their last line links the plan's out doc and the plan comment, `- <step>: full plan: <out doc>; plan comment: <url>`. Another step's assumptions keep ADR 0072's 200 characters.
- **The plan comment's address** is given to the status comment by the driver's wiring, as `https://<host>/<brewery>/issues/<n>#issuecomment-<id>` (`planComment` in `StatusEffectsOptions`). The driver asks every source what is due before it applies any, so the status revision of the tick that sticks the batch is decided before the plan comment exists, and names it from the next revision. A plan to review's revision is due at once, as one that shows the batch ended is (ADR 0072), and `foedrum brew` ticks once more after the batch sticks, so the comment it leaves names the plan comment.

Rejected: a rendering Foedrum writes beside the out doc on the state branch (a second file per plan for what the brewer can write and the engine can check); the whole assumptions in the status comment (the comment is cut to GitHub's length, and the out doc holds them whole); `?plain=1` for the plan (its body now reads).

### The plan comment is laid out for review
- **The link to the full plan first**, under the title: `Full plan: <out doc>`.
- **A table of five columns**: the sub-order (its id and title), its size, its recipe, what it depends on, and whether it is ready.
- **The flowchart only with two sub-orders or more**: a graph of one node says nothing the table does not.
- **A section per sub-order**, `#### <id>: <title>`: a list of where it builds and its mechanism and size, when it is done, its recipe and why (with test-first's reason when off), and why it is not ready when it is not; then its touched paths in a `<details>`, `Touches <n> paths`.
- **The alternatives, the Review and the Gate as before, and last, while the batch waits Stuck for a review of the plan, `Next:` and the next step**; the line goes when the batch moves on, so an on tap or cancelled batch is never told to retry.
- **A cut keeps the link and the next step and keeps whole blocks between them**: the graph goes first, as before; then the comment ends after the last block that fits, the table, a sub-order's section or a later section, with the cut's line, so a cut never leaves a `<details>` open over the rest. A table too long alone is cut to whole lines.

Rejected: the eight columns with shorter cells (a path list and a why are read one sub-order at a time, not compared across rows); the touched paths in the table (one cell held 13).

## Consequences
- A `mash` batch counts as an open order until a person ends it, so it holds a place under the open-order limit (ADR 0217) while it waits.
- A `mash` batch is listed by `foedrum stuck` and waits Stuck 🔔, reminded as every Stuck batch is, until a person retries, re-routes or cancels it; `foedrum brew` on it exits 3, not 0.
- Every status comment with a succeeded step gets one more revision when this ships, its step lines now linking their out docs, and every plan comment one more for its layout.
- A plan whose body leaves out its summary or an assumption costs an attempt; the Brewmaster's session resumes told which (ADR 0248).
- A `?plain=1` link stays for every out doc but the plan's until its schema gets a body the engine checks.
