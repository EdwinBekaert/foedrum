# 0323. A seeded plan measures the plan lenses, apart and together, after the merge

Date: 2026-11-05 · Status: Accepted · Amends [0224](0224-the-default-recipes-taste-apart-or-together-as-a-seeded-comparison-measured.md) (the comparison has a second mode, on a plan), [0321](0321-mash-and-decoction-review-a-plan-through-the-plan-lenses-apart.md) (how #804 measures its apart, and that the exercise #587 asked for runs after the merge) and [0220](0220-a-taster-s-step-can-run-several-lenses-together.md) (the fixed text on a step of plan lenses together)

## Context
ADR 0321 ships seven plan lenses, apart in `mash` and `decoction`, on the numbers ADR 0224 measured for diff lenses.
Nothing shows that each plan lens finds its own kind of mistake, or what apart and together spend on a plan.
#587 asked for that to be exercised before merging.
Decided with the maintainer on 2026-11-03: no real `claude` run in the session that builds it; the maintainer runs it after the merge, and the numbers go into a later docs pull request, whose ADR amends this record and ADR 0321 if they change the choice of apart or together.

Three facts stopped the diff mode from reading a plan as it is.
A plan's finding has no `file` or `line`: it starts its `why` with the sub-order's id (ADR 0312).
A batch that ends with a plan waits Stuck `plan_review` (ADR 0275), which the diff mode reads as a failed run.
And the default recipes hold only one recipe that builds, so recipe fit has nothing to judge (ADR 0321's lens says every entry that builds then fits it).

## Decision
- **The seeded plan** is `test/fixtures/tasting-compare/plan/`: an order, a plan of ten sub-orders on the diff mode's `0001-Start-pantry.patch` as its base, and `key.json`, one planted mistake per default plan lens, each with its lens, its `subOrders`, the `field` it is in and `what` it is. Two sub-orders stay clean as controls. Its README lists the expected findings.
- **A second recipe that builds**, `prose`, is part of the fixture, so recipe fit can judge a sub-order of code that names it.
- **Order and overlap's mistake is two entries side by side on one file**, not a dependency left out, which naive reader's "a dependency it cannot see" also asks about. Either sub-order of the pair counts for it, so a mistake's `subOrders` is a list. A test holds every other pair that shares a file in order.
- **What counts as found**, as ADR 0224: a finding on the planted sub-order, whatever lens it names, and own-lens hits apart through `lensOfFinding`. The sub-order is read from the very start of the `why`, up to its first colon, with or without backticks around it (ADR 0312); a list of ids there counts for each, since a finding on the planted pair may name both. A finding on a clean sub-order or on none is listed for a person to judge, and so is one on a mistake of a lens outside the setup.
- **A finished run** ends `stuck: plan_review` with no failed Taster attempt; any other end fails it, and it is run again at most once, as ADR 0224 says.
- **The setups**: `plan-apart-7`, `plan-together-7` and `plan-together-mash` run, 3 runs each, and `plan-apart-mash` is read from `plan-apart-7`'s coverage, sizing and naive reader attempts, with no wall time of its own, as ADR 0224 reads Nip's. Their records, runs and table stay under `.foedrum/tmp/tasting-compare/plan/`.
- **The recipes**: a scripted plan step on the Brewmaster (no model), then the Tasters, with no blocking step and no route, so a run measures one round and ends at the review. A test pins each apart step to the model `decoction` gives its lens.
- **A step together names no model**, so it is on the Taster's own `builder`: ADR 0220 gives a step its brewer's model and rejects the strongest of its lenses'. ADR 0224's rule sums the tokens of any model alike, so on `planner` a step together could pass its 30 % with all its tokens on that alias, where apart has two lenses of seven there. On `builder` the tokens are not alike either, and the numbers' ADR must say so: a miss on coverage or security may come from the model or from tasting together, and the table cannot tell which.
- **The rule that picks** is ADR 0224's, with no new numbers: together when it finds on average at least as many planted mistakes as apart, less half a mistake, with at least 30 % fewer tokens. A together `mash` would also change what blocks, since `"blocking": true` on a `lenses` step blocks on any lens (ADR 0220) and `mash` blocks on two of its three; one round with no blocking step cannot measure that, so a choice of together needs that settled in the record that makes it.
- **The fixed text on a step of plan lenses together** says to review the plan, and its example finding has no `file` or `line` and a `why` that starts with the sub-order's id. It said the change, with a file and a line, which a plan's Taster has neither of, and no default recipe had reached it. The text for diff lenses stays byte for byte.
- **The procedure.** `node scripts/tasting-compare.ts --plan [--runs <n>]` on a checkout with `claude`'s login; `--dry-run` scripts the Tasters too, each reporting the key's mistakes of its lenses, and spends no token. The diff mode's command, folder and table stay as they were.
- **The numbers are still to come.** None exists when this record is accepted. The maintainer's run after the merge gives them, and a docs pull request records them, by an ADR that amends this one and ADR 0321 if they change the choice.

## Consequences
- `mash` and `decoction` keep tasting apart until those numbers say otherwise; ADR 0321's choice stands on the diff lenses' numbers until then.
- A dry run's table shows the shape, not a measurement: every scripted lens finds its mistake with no tokens, which would pass the rule, so in plan mode it says that it measures nothing and makes no choice. The diff mode's dry run stays as it was, choice line included.
- A plan step that is scripted reaches no `touchesChecked`, which only the claude and interactive runners run (ADR 0233), so a unit test holds the plan's touches against the base patch's files.
- One round measures the first plan's review only, not the rounds a blocking step sends back; ADR 0321's question whether a fifth plan is reached stays open.
- One seeded plan is a small sample, as ADR 0224 says of its change.
- A lens that misses its own mistake apart is a finding about that lens, for an issue of its own.

## Alternatives considered
- **A second script.** It would repeat the shell's scratch Brewery, target and store; the mode shares them and keeps its decisions in `scripts/tasting-compare/plan.ts`.
- **A run of `plan-apart-mash` as a fourth setup.** The same steps as three of `plan-apart-7`'s, on the same plan: three more runs that measure nothing new, as ADR 0224 says of Nip's.
- **A together step on `planner`.** See the decision.
- **A real Brewmaster writing the plan.** Its mistakes would not be planted, and each run would review another plan.
- **A `subOrder` field on a finding.** ADR 0312 keeps it in the `why` until a reader needs it; this reader reads the start of the `why`, a list of one or two ids, and a person reads the rest.
