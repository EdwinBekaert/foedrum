# 0372. The deep planning recipe is called deep-mash

Date: 2026-11-11 · Status: Accepted · Amends [0321](0321-mash-and-decoction-review-a-plan-through-the-plan-lenses-apart.md) (the deep planning recipe is called `deep-mash`, its label `recipe:deep-mash`) and [0365](0365-a-recipe-has-a-type-mash-or-brew.md) (the default recipes of type `mash` are Mash-in, Mash and Deep-mash, and the recipes that planned before types are `mash` and `mash-in`)

## Context
The careful plan of a large order, `mash`'s steps through all seven plan lenses ([ADR 0321](0321-mash-and-decoction-review-a-plan-through-the-plan-lenses-apart.md)), was called `decoction`, which is hard to say (#931).
`deep-brew` builds a change that can reach a lot ([ADR 0366](0366-deep-brew-builds-a-change-that-can-reach-a-lot-through-every-diff-lens-and-a-blocking-brett-step.md)); the deep plan sits beside it as `mash` sits beside `nip`.
Foedrum has no release: no Brewery holds a batch, a label or a `defaultRecipe` that names `decoction`.

## Decision
- **`decoction` becomes `deep-mash`**: the default recipe file `defaults/recipes/deep-mash.jsonc` and its `name`, the label `recipe:deep-mash`, the Innkeeper's prompt (version 7), which suggests `deep-mash` for a deep plan, `scripts/tasting-compare`, the tests, the design pages, the glossary and the M2 milestone page.
- **No alias.** The engine knows no old name: a `recipe:decoction` label, `foedrum recipe <n> decoction` or a `defaultRecipe` of `decoction` gets the line any name the Brewery lacks gets.
- **`foedrum status` counts `mash` and `mash-in` as planning for a choice from before types**, no longer `decoction`: no ledger holds one.
- Older ADRs keep the word, and so do the links to their file names, which must match the files.

Rejected: keeping `decoction` as an alias for batches that recorded it, with a refusal of new choices of the old name that names the new one; it guards against a ledger no Brewery has, since Foedrum has no release.

## Consequences
- `git grep -i decoction` outside `docs/adr/` finds only links to ADR 0321's file name.

## Migration
None: Foedrum has no release, so no Brewery's files or batches name `decoction`.
