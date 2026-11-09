# 0312. A Taster on a plan lens step reads the batch's latest plan, and ties each finding to a sub-order

Date: 2026-11-03 · Status: Accepted · Amends [0143](0143-lenses-in-two-folders-diff-and-plan.md) (what a step that reviews a plan reads, and how a house-yeast rule names a plan lens), [0161](0161-lens-steps-run-a-taster-whose-findings-are-advisory-unless-the-step-blocks.md) (the input a lens step's Taster reads besides its lens), [0286](0286-foedrum-lauter-corrects-a-plan-at-gate-1-in-an-interactive-session.md) (the batch's plan reaches one more kind of step, and its input's source names the plan attempt) and [0169](0169-house-yeast-rules-reach-a-batch-s-brewers-by-scope-and-lens.md) (a plan lens step reads a repository's rules at the commit its worktree holds, with no file changed) · Amended by [0317](0317-the-planners-read-a-system-map-computed-from-each-repository-s-manifests-with-no-model.md), [0318](0318-a-plan-lens-s-findings-go-back-to-the-plan-step-and-the-plan-comment-lists-the-review-notes-left.md) and [0321](0321-mash-and-decoction-review-a-plan-through-the-plan-lenses-apart.md)

## Context
Since ADR 0143 a lens step with no committing step before it reviews a plan and must name a lens of `lenses/plan/`.
Since ADR 0275 such a step after `plan` runs before the batch waits Stuck `plan_review`, so its findings would be there at gate 1.
But a lens step's Taster got only what a diff's gets: the engine adds the `change` input for a `diff/` lens (ADR 0161), and nothing for a `plan/` lens.
The batch's plan is the `plan` input (ADR 0286), which only a step a person's choice schedules reads, so a plan lens step reviewed nothing.
`defaults/lenses/plan/` was empty, and `taster.md` asked for a change and for a line at HEAD for each finding.
A plan's mistakes are about its sub-orders, not lines of code: an entry its brewer cannot build alone, a path the work needs that its touches leave out.
Decided with the maintainer on 2026-11-03 (#800, split from #587): the plan lenses taste apart (ADR 0224's rule), and no real-model run is part of this record.

## Decision
- **The plan.** On a step whose lenses are of `lenses/plan/` (the folder ADR 0143's load checks), the engine adds the batch's latest plan as the input `plan`, after the brewer's own inputs: the out doc of the latest attempt that succeeded with a plan, read where that attempt ran, as ADR 0286's input is read.
  Its tag names that attempt: `the plan of step plan#2`.
  The `plan` input a brewer names itself is still left out of a step no choice scheduled (ADR 0286).
  A plan lens step before the batch has any plan fails its attempt's plan: `the input "plan" needs the batch's plan, which it has none of yet`.
- **The repositories.** The same step gets the Brewery's repositories as the input `repositories` (ADR 0234), as the Brewmaster does, so a lens can read whether the code already does what an entry asks.
  A Taster is read-only, so in a Brewery order in a Brewery of several repositories it already runs in a folder of checkouts, one per repository (ADR 0301), and the input names each folder.
- **No change.** A plan lens step gets no `change` and no later round's change, and its house yeast is read at the commit its worktree holds, with no file changed, so only the rules that name neither files nor a language apply, each by its lens (ADR 0169): `plan/<name>` or a bare name, as `scope.lens` already reads them.
  A Taster in a folder of checkouts has no repository of its own, and gets no house yeast, as before.
- **The finding's place.** No field is added to `tasting`.
  A finding about one sub-order starts its `why` with the sub-order's id (`writer: …`) and leaves `file` and `line` out, unless it points at a file and line the Taster read in a repository.
  The status comment and `foedrum lenses` show a plan lens's findings and tokens as they show a diff lens's: they key by the lens, not its folder.
- **The Taster.** `taster.md` (version 6) reads either: when `{plan}` is given, it reviews the plan against the order and the repositories, not a diff.
- **One default plan lens.** `defaults/lenses/plan/naive-reader.md` reads each sub-order's entry alone, with the order, as the brewer that builds it will, and reports what that brewer would have to guess.
  No default recipe runs it yet.

## Consequences
- A Brewery recipe with a `plan/naive-reader` step after `plan` gets review notes on its plan before gate 1, in the status comment.
- Routing a plan lens's findings back to the Brewmaster is #801; the other plan lenses and their place in `mash` and `decoction` are #802; the security lens's mark on a sub-order is #803; measuring the lenses is #804.
- A finding tied to a sub-order lives in its `why` text: a reader that wants it as a field (a plan comment that shows notes under each entry) parses the id from the start of the `why`, which #801 or #802 may turn into a field once a reader needs it.

## Alternatives considered
- **Lift ADR 0286's `chosen` restriction for a plan lens step**, so a Taster that names `from: "plan"` gets it. The default Taster would then name an input that every diff step leaves out, and a Brewery Taster without it would review nothing; the engine already decides what a lens step reads from its folder, as it does the change.
- **A `subOrder` field on a finding.** One more schema field for every lens, read by nothing yet; the id at the start of the `why` holds the same until a reader needs it.
- **Give the plan in place of `change`, under that name.** The Taster's rules about a change (lines at HEAD, `introduced`) would then speak of a plan without saying so; a name of its own lets the prompt say which it has.
