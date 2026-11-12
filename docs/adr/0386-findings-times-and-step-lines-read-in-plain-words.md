# 0386. Findings, times and step lines read in plain words

Date: 2026-11-12 · Status: Accepted · Amends [0154](0154-lane-labels-on-the-order-s-issue-and-the-status-comment-s-path-line.md) (the path line's head), [0169](0169-house-yeast-rules-reach-a-batch-s-brewers-by-scope-and-lens.md) (where a finding names the house rule it breaks), [0222](0222-a-recipe-s-brewer-step-may-be-interactive.md) (the time on an open session's step line), [0272](0272-the-status-comment-names-a-pull-request-once-and-breaks-its-path-per-round.md) (the words the path's first line begins with), [0275](0275-a-finished-plan-waits-stuck-for-its-review-and-every-comment-links-the-doc-it-sums-up.md) (the out doc's link on a step's line) and [0294](0294-npm-run-demo-ladder-walks-an-order-across-two-repositories.md) (the recipe line the ladder demo shows)

## Context
Three texts a person reads needed the engine's words to make sense (#927).
`npm run demo -- ladder` on main showed two of them:
- `foedrum status` printed `1-1  #1  queued  to be routed by 2026-11-12T16:48:20.054Z`: a time with a `T`, seconds and milliseconds.
- The status comment's step block read `Recipe **mash**, chosen by its label`, then `Path: \`plan #1\` ✅ → …`, then `- ✅ \`plan\`: out doc: [1-1/plan-1.md](…)`.
  It does not say which label, what a path or `#1` is, or that an out doc is the step's report.

The third is a finding.
A Taster's `why` started with whatever came first to it, often a file, a rule id or a sub-order id, and the pull request body, the merge brief and the plan comment show it as written.
For example: `minor in src/cli/status.ts:119: docs/design/humans/commands.md line 10 says …`.

The maintainer decided (2026-11-12) to change these three and nothing else.
The labels, command names, batch ids, the engine's states, events and schemas, the ADR numbers in code comments and terminal lines, and every other command's own lines stay as they are.

## Decision
- **A finding starts with one plain sentence.** The default Taster's prompt (`defaults/brewers/taster.md`, version 12) asks for each finding's `why` to start with one sentence written for a person who hasn't followed the work: what is wrong, why it matters and what to do, with no file, line, rule id or ADR number in it.
  The scenario, the rule and its file come after that sentence.
  A finding that breaks a house rule names the rule's id after the first sentence, such as `(cents)`, instead of starting with it.
  A plan's finding still starts with its sub-order's id, the place it is about, as the plan lenses ask; the plain sentence follows it.
  Only the prompt changes: one shared line serves all 14 default lenses, and no schema field is added.
- **A time reads to the minute in UTC.** `utcMinute` (`src/engine/wall-clock.ts`) writes an ISO instant as `2026-11-12 13:36 UTC`, and a text that is no instant as it is.
  `foedrum status` and `foedrum stuck` print every time this way: the routing deadline, each reminder, a passed deadline, `failing … since`, `stalled … since`, and when an order changed after its approval (`changesText`).
  The lines come from `describeLane` and `stuckOn`, which `foedrum brew`, `replay` and `resume` share, so their lines change in the time's form only, and a time reads the same on every terminal line.
  `changesText` also writes the status comment's line of an order that changed, which reads its times the same way.
- **The step lines say what ran and where its report is.**
  - The recipe line names the label that chose it: `Recipe **mash**, chosen by the issue's \`recipe:mash\` label`.
  - The path's first line starts `Steps run, in order (#n is the nth try of a step):` instead of `Path:`.
  - A step done with an out doc reads `- ✅ \`plan\`: done, its report: [plan-1.md](…)`, its link named by the file alone; one done without an out doc, as a check step, reads `- ✅ \`green\`: done`; one not run yet reads `- ⬜ \`fine\`: not run yet`.
  - An open session's line says since when in the same form: `session open since 2026-11-12 13:36 UTC`.
  - Step ids and the `step #n` code spans stay, since `retry`, `skip` and `replay` take them; the Assumptions' `full plan:` link keeps its label.

## Consequences
- A person reads a finding's first sentence without knowing the code, and a time without parsing it.
- The status comment's step block can be read without the glossary.
- A Brewery's own copy of `taster.md` keeps its own words, and its findings read as before.
- A time shown to the minute drops its seconds: a deadline of `13:36:59` reads `13:36`.
- The status comment's other times keep their form, outside this decision, which asked for the times of `foedrum status`: its failing line, a Stuck reason's passed deadline, `stalled … since` and routing deadline, and the line of a pull request whose checks it waits for.
- **Brewery migration:** none; Foedrum has no release.
