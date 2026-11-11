# 0372. The deep planning recipe is called deep-mash

Date: 2026-11-11 · Status: Accepted · Amends [0321](0321-mash-and-decoction-review-a-plan-through-the-plan-lenses-apart.md) (the deep planning recipe is called `deep-mash`, its label `recipe:deep-mash`), [0365](0365-a-recipe-has-a-type-mash-or-brew.md) (the default recipes of type `mash` are Mash-in, Mash and Deep-mash, and `foedrum status` reads only a choice's recorded type), [0285](0285-an-approved-plan-becomes-brewery-sub-issues-through-the-ledger.md) (no list of the recipes that planned before types: Foedrum has no release, so no ledger holds a choice from before them), [0232](0232-foedrum-mash-routes-an-issue-to-the-innkeeper-whose-question-the-answer-chooses-the-recipe-by.md) (the Innkeeper is offered `deep-mash`, and its example suggests it), [0323](0323-a-seeded-plan-measures-the-plan-lenses-apart-and-together-after-the-merge.md) (each apart step of the plan comparison is pinned to the model `deep-mash` gives its lens), and [0220](0220-a-taster-s-step-can-run-several-lenses-together.md), [0224](0224-the-default-recipes-taste-apart-or-together-as-a-seeded-comparison-measured.md), [0234](0234-the-brewmaster-writes-a-plan-on-the-planner-alias-and-mash-runs-it.md), [0286](0286-foedrum-lauter-corrects-a-plan-at-gate-1-in-an-interactive-session.md), [0312](0312-a-taster-on-a-plan-lens-step-reads-the-batch-s-latest-plan-and-ties-each-finding-to-a-sub-order.md), [0322](0322-a-sub-order-s-security-mark-is-the-brewmaster-s-and-reaches-its-plan-entry.md), [0343](0343-nip-tastes-through-design-conformance-as-a-fourth-advisory-lens.md), [0349](0349-a-group-s-round-back-carries-every-finding-of-the-round.md), [0352](0352-nip-s-correctness-acceptance-and-security-tasters-run-at-high-effort-without-the-rules-read.md), [0354](0354-every-finding-of-a-taster-goes-back-along-one-on-findings-route.md) and [0357](0357-after-a-round-back-a-group-runs-again-only-its-every-round-children-and-those-with-findings.md) (the recipe each names as `decoction` is `deep-mash`)

## Context
The careful plan of a large order, `mash`'s steps through all seven plan lenses ([ADR 0321](0321-mash-and-decoction-review-a-plan-through-the-plan-lenses-apart.md)), was called `decoction`, which is hard to say (#931).
`deep-brew` builds a change that can reach a lot ([ADR 0366](0366-deep-brew-builds-a-change-that-can-reach-a-lot-through-every-diff-lens-and-a-blocking-brett-step.md)); the deep plan sits beside it as `mash` sits beside `nip`.
Foedrum has no release: no Brewery holds a batch, a label or a `defaultRecipe` that names `decoction`.

## Decision
- **`decoction` becomes `deep-mash`**: the default recipe file `defaults/recipes/deep-mash.jsonc` and its `name`, the label `recipe:deep-mash`, the Innkeeper's prompt (version 7), which suggests `deep-mash` for a deep plan, `scripts/tasting-compare`, the tests, the design pages, the glossary and the M2 milestone page.
- **No alias.** The engine knows no old name: a `recipe:decoction` label, `foedrum recipe <n> decoction` or a `defaultRecipe` of `decoction` gets the line any name the Brewery lacks gets.
- **`foedrum status <order>` reads only the type a recipe choice recorded**: an attempt of a recipe of type `mash` is planning, any other brewing.
  The list of the recipes that planned before types (`mash`, `mash-in` and `decoction`), which read a choice with no recorded type, goes: Foedrum has no release, so no ledger holds such a choice.
- Older ADRs keep the word, and so do the links to their file names, which must match the files.

Rejected: keeping `decoction` as an alias for batches that recorded it, with a refusal of new choices of the old name that names the new one; it guards against a ledger no Brewery has, since Foedrum has no release.

## Consequences
- `git grep -i decoction` outside `docs/adr/` finds only links to ADR 0321's file name.
- `recipeType` stays optional on `batch.recipe_chosen`, as its schema has it; `foedrum status` counts an attempt whose choice recorded none as brewing.

## Migration
None: Foedrum has no release, so no Brewery's files or batches name `decoction`.
