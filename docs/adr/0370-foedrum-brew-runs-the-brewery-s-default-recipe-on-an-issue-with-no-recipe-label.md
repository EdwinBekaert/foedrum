# 0370. foedrum brew runs the Brewery's default recipe on an issue with no recipe label

Date: 2026-11-10 · Status: Accepted · Amends [0123](0123-foedrum-brew-drives-one-batch-under-an-owner-of-its-own.md) (an issue with no recipe label is no longer refused, and its route is the router's, recorded without `by` or `via` as the label's is), [0232](0232-foedrum-mash-routes-an-issue-to-the-innkeeper-whose-question-the-answer-chooses-the-recipe-by.md) (`foedrum brew` on an issue with no recipe label runs a recipe of type `mash`, `mash-in` unless the Brewery names another, where it refused; `foedrum serve` still waits) and [0156](0156-a-claimed-order-is-routed-by-its-brewery-issue-s-recipe-label.md) (a brew of a claimed order whose Brewery issue has no label runs the default there, where it waited for a label)

## Context
`foedrum brew <n>` on an issue with no `recipe:<name>` label refused: `has no recipe:<name> label; label it with the recipe to brew it with`.
A claimed order's brew opened its Brewery issue, then refused in the same way, naming `foedrum mash`.
So a person had to know the recipes, or a second command, before anything happened (#930).
`foedrum mash <n>` is the same program routed to `mash-in`, whose Innkeeper suggests a recipe and asks which one brews the issue ([ADR 0232](0232-foedrum-mash-routes-an-issue-to-the-innkeeper-whose-question-the-answer-chooses-the-recipe-by.md)).
A recipe now has a type, and `mash` builds nothing ([ADR 0365](0365-a-recipe-has-a-type-mash-or-brew.md)).
ADR 0232 rejected routing every unlabelled order to `mash-in`: a model call for every issue nobody asked about.

## Decision
- **`defaultRecipe` in `foedrum.jsonc`**, optional, names the recipe `foedrum brew` runs for an issue with no recipe label; left out, it is `mash-in`.
- **It must be a recipe of the Brewery of type `mash`**, so an unlabelled issue never starts building by accident.
  Another, or a name the Brewery lacks, is a problem of its own line, `foedrum.jsonc's defaultRecipe names <name>, of type brew: name a recipe of type mash, or leave it out for mash-in`, or `…, which is no recipe of this Brewery: …`.
  `BreweryConfig` cannot see the recipes, which load apart from it, so one check where both are known, `defaultRecipeProblem` beside `loadRecipes` (`src/engine/recipe-files.ts`), gives the line to `serveSetup` and to doctor: `foedrum serve`, `foedrum brew` and every other command that sets up as serve does refuse to start with it, and `foedrum doctor` names it.
- **`foedrum brew <n>` with no recipe label routes the batch to that recipe** in place of refusing, before anything is ordered, and drives it as any brew: with `mash-in` it ends at the Innkeeper's question and the `foedrum answer` line, exit 4.
  This covers an issue with no batch, an Ordered batch, a claimed order whose Brewery issue is open, and a claimed issue whose Brewery issue the brew opens: that fresh issue has no label, so after the tick that opens it the batch is routed to the default there.
- **The route is the router's**: `batch.recipe_chosen` with `source: "router"` and the reason `the Brewery's default recipe, for an issue with no recipe label`, which the status comment shows as `chosen by the router: …`.
  A router's choice labels nothing, so the issue's next order is routed as it is; the answer to the Innkeeper's question labels the issue with the recipe it chooses, as ADR 0232 says.
  The route records no person: who ran the brew is in `batch.ordered`'s `by` and `via` when the brew ordered the issue, and nowhere when the batch was Ordered already; no new field records it.
- **A Brewery whose default cannot run says so in one line**, before anything is ordered, as `foedrum mash` does: the Brewery has no recipe of that name (a left-out default whose `mash-in` the Brewery replaced away), its default is not of type `mash` (a left-out default whose `mash-in` the Brewery replaced with one that builds, which no configuration check sees, since such a Brewery may still serve labelled issues), or the default's first step chooses a recipe and has fewer than two to offer (ADR 0006).
  `#13 has no recipe:<name> label, and the Brewery's default recipe mash-in has one recipe to offer, stout; label it with the recipe to brew it with, or choose one with foedrum recipe 13 <recipe> "<reason>"`.
  A claimed issue with no Brewery issue yet is claimed, ordered and its Brewery issue opened first, as before, and its line then names that Brewery issue: `web#7 waits for a recipe:<name> label on its Brewery issue #40, and …; label it and brew 40, or choose one with foedrum recipe 40 <recipe> "<reason>"`, no longer naming `foedrum mash`, which would refuse in the same way.
- **Two recipe labels, or a label naming a recipe the Brewery lacks, are refused as before**: only an issue with none runs the default.
- **`foedrum mash <n>` stays** the explicit way to ask, whatever the default.
- **`foedrum serve` does not change**: the intake orders no Brewery issue without a label, and an Ordered batch nobody routes still goes Stuck on routing at its deadline ([ADR 0032](0032-routing-deadline-for-ordered-batches.md)).
  ADR 0232's reason still stands there: serve would spend a model call on every unlabelled issue anyone opened, while `foedrum brew <n>` is a person asking about that one issue now.
- **`foedrum init` does not ask it**: the setting is optional and its default needs no answer, and init asks only what a Brewery must have.

Rejected: the default as a person's choice (`source: "human"`, as `foedrum mash` records): a default other than `mash-in` would label the issue with a planning recipe, and route its next order there; checking the type when `foedrum.jsonc` is parsed (the schema has no recipes to read); `foedrum serve` running the default too (the model call ADR 0232 rejected).

## Consequences
- `foedrum brew` on an unlabelled issue starts the Innkeeper, one model call, where it refused; the answer chooses the recipe.
- A batch Stuck on routing is not routed by `foedrum brew`, as before: `foedrum mash` or `foedrum recipe` routes it.
- A target issue's own recipe label still chooses nothing, and the brew still says so (ADR 0156).

## Migration
None: `defaultRecipe` is optional and defaults to `mash-in`, which ships with Foedrum.
A Brewery that replaced `mash-in` with no recipe of that name gets brew's one-line refusal for an unlabelled issue, as it got one before, and can name another recipe of type `mash`.
