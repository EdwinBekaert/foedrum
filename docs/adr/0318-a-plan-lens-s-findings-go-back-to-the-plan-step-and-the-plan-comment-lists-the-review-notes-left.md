# 0318. A plan lens's findings go back to the plan step, and the plan comment lists the review notes left

Date: 2026-11-03 · Status: Accepted · Amends [0191](0191-the-step-a-findings-route-goes-back-to-records-a-disposition-for-each-finding.md) (a plan step records dispositions too, and a plan lens's later round reads them as a plan's), [0204](0204-a-dismissal-names-the-evidence-that-shows-it.md) (the evidence a plan's dismissal names), [0233](0233-a-plan-is-an-out-doc-whose-paths-the-engine-checks-shown-as-one-comment-per-order.md) (the plan comment is also due when a plan lens round ends), [0275](0275-a-finished-plan-waits-stuck-for-its-review-and-every-comment-links-the-doc-it-sums-up.md) (the plan comment's Review section), [0286](0286-foedrum-lauter-corrects-a-plan-at-gate-1-in-an-interactive-session.md) and [0312](0312-a-taster-on-a-plan-lens-step-reads-the-batch-s-latest-plan-and-ties-each-finding-to-a-sub-order.md) (one more kind of step gets the plan input it names)

## Context
Since ADR 0312 a Taster on a plan lens step reviews the batch's latest plan and starts each finding's `why` with the sub-order it is about.
A blocking plan lens step can name `onBlocked: { findings: { goto: "plan", maxRounds } }` (ADR 0264): the engine's route, its route input (ADR 0128), the later round's earlier findings (ADR 0191) and a plan step's attempts counted since its latest plan (ADR 0289) already work for a plan step, and a test recipe `plan` → `naive` showed it (#801).
Four parts were missing:
- the Brewmaster (`defaults/brewers/brewmaster.md`, version 3) said nothing about a route input, dispositions or evidence;
- its routed attempt got the Taster's findings but not the plan they name: the `plan` input went only to a step a person chose (ADR 0286);
- a later plan lens round was told a diff's evidence (a file and line, a test, a sentence of the order or of a decision record), and read a finding with no file as "in the change as a whole";
- the plan comment's Review section said "None yet." whatever its lenses found, so a person at gate 1 saw no dismissed or advisory finding.

Decided with the maintainer (2026-11-03): plan lenses taste apart; in `mash` coverage and sizing block while naive reader advises, which is #802; here a test recipe proves the route.

## Decision
- **The route back to a plan step needs no new engine rule.** A findings round back to `plan` is scheduled after a plan succeeded, so it has the Brewmaster's `maxAttempts` afresh (ADR 0289); the route's `maxRounds` bounds the rounds.
- **A routed plan step gets the plan.** An attempt a findings route scheduled gets the `plan` input its brewer names, the batch's latest plan, as a chosen step does (ADR 0286): the findings name its entries, and it corrects that plan.
- **The Brewmaster's dispositions.** Its out doc already accepts the shared `dispositions` field (ADR 0191); no schema change. Its prompt (version 4): with a route input, correct the plan, write it whole, and record one disposition per finding in the Taster's order, `fixed` or `dismissed`, never `pre-existing` (a plan has nothing that was there before it); never drop or merge a sub-order only to make a finding go away.
- **A plan's evidence.** A `dismissed` `why` names a line of the order, a file and line in a repository, or a field of the plan. A later round of a plan lens step gets the engine's fixed text that says so, in place of a diff's, and reads a finding with no file as "in the plan as a whole" (`earlierFindingsInput`, `src/brewers/attempt-plan.ts`).
- **The Review section lists the notes left at gate 1** (`reviewNotes`, `src/engine/plan-comment.ts`), from the fold alone: for each step whose latest round reviewed after the latest plan, in the order the steps ran,
  - each finding of an earlier round the plan dismissed (or left as there before), with its `why` on a line below it;
  - each finding of the latest round, `advisory` when that round succeeded, `open` when it ended blocked, as when the route ran out of rounds (ADR 0192).
  A fixed finding leaves no note: it is in the plan.
  A line reads `` - `naive` #1: major, dismissed: docs: … `` then `  - why: …`; the finding's lens comes first when it names one, and its sub-order is the start of its `why` (ADR 0312).
  Each text is one escaped line, left out for a fixed line naming its step when it looks like a secret, a finding's naming the lens step and a why's the plan's.
  **The cut**: ten notes per step, then `` - `naive`: and <n> more ``, as the status comment's findings; past GitHub's length, the comment's whole-block cut is as before (ADR 0275).
  **No round**: "None yet." while no step reviewed the plan; "No findings." when steps did and left no note.
  The notes are part of the comment's text, so a plan lens round that ends makes a revision of the plan comment due, as a new plan does (ADR 0233).

## Consequences
- Once #802 runs plan lenses in `mash`, a person at gate 1 sees what its lenses found and what the Brewmaster did about each, and approves, lauters or retries knowing it.
- The Brewmaster reads a little more on a routed attempt: the plan, at most 1 MiB as every input, beside the route input's 64 KiB.
- A person's `retry` from `plan_review` plans again without a route, so it gets neither the findings nor the plan, as before (ADR 0275); the lens steps after it review the new plan, and the Review keeps the earlier rounds' dismissals of that step.
- A retry of a routed attempt starts without the route, as ADR 0128 records, and so without the plan.

## Alternatives considered
- **A schema of its own for a plan's dispositions, without `pre-existing`.** A schema change and an older Foedrum that cannot read it, for a value the prompt already rules out and the comment shows as written.
- **A `subOrder` field on a finding, to show the notes under each sub-order's section.** ADR 0312 keeps the sub-order at the start of the `why` until a reader needs it as a field; a list in the Review section needs none.
- **Every round's findings in the Review.** An earlier round's open finding was judged again by the round after it; only what is left at the gate is a note.
- **Re-plan without the plan, from the order and the findings alone.** The findings name entries of a plan the routed attempt could not read, and a fresh plan would answer them by chance.
