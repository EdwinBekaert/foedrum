# 0372. decoction becomes deep-mash, and a batch that recorded it carries on

Date: 2026-11-11 · Status: Accepted · Amends [0321](0321-mash-and-decoction-review-a-plan-through-the-plan-lenses-apart.md) (the deep planning recipe is called `deep-mash`, its label `recipe:deep-mash`) [0365](0365-a-recipe-has-a-type-mash-or-brew.md) (the default recipes of type `mash` are Mash-in, Mash and Deep-mash) and [0068](0068-the-intake-in-foedrum-serve-brewery-orders-and-routing-by-label.md) (a `recipe:<name>` label naming a default recipe's old name is refused with its new one, where it routed)

## Context
The careful plan of a large order, `mash`'s steps through all seven plan lenses ([ADR 0321](0321-mash-and-decoction-review-a-plan-through-the-plan-lenses-apart.md)), was called `decoction`, which is hard to say (#931).
`deep-brew` builds a change that can reach a lot ([ADR 0366](0366-deep-brew-builds-a-change-that-can-reach-a-lot-through-every-diff-lens-and-a-blocking-brett-step.md)); the deep plan sits beside it as `mash` sits beside `nip`.
A batch keeps the name of its recipe in its events: `batch.recipe_chosen`'s `recipe`, and each attempt's `recipe` on `step.scheduled`.
The registry `loadRecipes` returns finds a recipe, its brewers and its checks by that name, and `decide` refuses a name it cannot find with `the Brewery has no recipe <name>`.
So with the file renamed alone, a batch that recorded `decoction` and has not ended would be refused at its next step, on `retry`, at `lauter` and at `approve`, until it is marked after an hour ([ADR 0335](0335-a-batch-that-keeps-failing-is-marked-after-an-hour-and-stuck-when-a-reading-hides-its-deadline.md)), and a person would cancel it and order it again.

## Decision
- **`decoction` becomes `deep-mash`**: the default recipe file `defaults/recipes/deep-mash.jsonc` and its `name`, the label `recipe:deep-mash`, the Innkeeper's prompt (version 7), which suggests `deep-mash` for a deep plan, `scripts/tasting-compare`, the tests, the design pages and the glossary.
  Older ADRs keep the word, and so do the ADR file names other files link to.
- **A batch that recorded `decoction` carries on as `deep-mash`.**
  The registry keeps a map of a default recipe's old name to its new one, `decoction` to `deep-mash` (`RENAMED` in `src/engine/recipe-files.ts`), and finds the recipe, its brewers and its checks by either name, when the Brewery has no recipe of its own called `decoction` and has one called `deep-mash`.
  Its next step, a `retry`, `lauter` and `approve` run as they did, and the batch keeps the name it recorded.
- **A new choice of the old name is refused in one line that names the new one.**
  `Recipes.renamed` gives the new name of an old one; `decide` refuses a route, a person's `recipe` and the answer to the Innkeeper's question that chooses it: `the recipe decoction is called deep-mash now; choose deep-mash, or label the issue recipe:deep-mash`.
  `serve`'s intake reports that line once for an issue labelled `recipe:decoction`, which stays Ordered; `foedrum brew` refuses before anything is ordered: `#12 carries recipe:decoction, a recipe called deep-mash now; label it recipe:deep-mash`.
- **A Brewery's own `decoction` stays its own**: a Brewery file of that name is found by it and chosen as before, with no refusal.
- **The map stays.** A batch's events keep the name forever, and `foedrum status` and the status comment read ended batches as long as the store holds them.
- **An ended batch needs nothing.** `foedrum status <order>` counts a `decoction` batch's planning tokens as planning by the type its choice recorded, `mash`, or, for a choice from before types, by the frozen list that holds `decoction` ([ADR 0365](0365-a-recipe-has-a-type-mash-or-brew.md)).

Rejected: a refusal only, naming the fix (cancel and brew again, or `foedrum recipe <n> deep-mash`), since every lookup that refuses or skips a batch by its recipe's name would need that line, and every unfinished batch a person; routing `recipe:decoction` to `deep-mash` silently, since a label nobody changes keeps the old name in the Brewery for good.

## Consequences
- A person who labels an issue `recipe:decoction`, or runs `foedrum recipe <n> decoction`, is told the new name and nothing is routed.
- An Innkeeper question asked before the rename that offers `decoction` cannot be answered with it: the refusal names `deep-mash`, which the answer cannot name either, since it is not among that question's options; `foedrum recipe <n> deep-mash` chooses it.

## Migration
An existing Brewery:
- relabels any issue carrying `recipe:decoction` with `recipe:deep-mash`, and renames the label if it keeps one; Foedrum's own Brewery has no issue with that label and no such label (ran, 2026-11-11);
- renames any file of its own that names `decoction` and changes what refers to it, such as `foedrum.jsonc`'s `defaultRecipe`, which still finds `deep-mash` by the old name; a Brewery recipe file called `decoction.jsonc` keeps working as its own, under that name;
- does nothing for an unfinished `decoction` batch: it carries on as `deep-mash`.
