# 0365. A recipe has a type, mash or brew

Date: 2026-11-10 · Status: Accepted · Amends [0285](0285-an-approved-plan-becomes-brewery-sub-issues-through-the-ledger.md) (a sub-order's recipe is one of type `brew`, not one outside a list of names), [0232](0232-foedrum-mash-routes-an-issue-to-the-innkeeper-whose-question-the-answer-chooses-the-recipe-by.md) and [0234](0234-the-brewmaster-writes-a-plan-on-the-planner-alias-and-mash-runs-it.md) (what the recipes input lists), [0295](0295-foedrum-status-order-shows-planning-tokens-apart-from-brewing-tokens.md) (what counts as planning: a recipe of type `mash`, not a list of names) and [0321](0321-mash-and-decoction-review-a-plan-through-the-plan-lenses-apart.md) (a plan lens is offered the recipes of type `brew`, and `PLANNING_RECIPES` is gone)

## Context
A recipe did not say what kind of work it does.
"This recipe plans" was a list of three names, `PLANNING_RECIPES` in `src/schemas/plan.ts`: a sub-order could not name one of them ([ADR 0285](0285-an-approved-plan-becomes-brewery-sub-issues-through-the-ledger.md)), and `foedrum status <order>` counted their attempts' tokens as planning ([ADR 0295](0295-foedrum-status-order-shows-planning-tokens-apart-from-brewing-tokens.md)).
A planning recipe a Brewery wrote under another name was neither refused for a sub-order nor counted as planning.
The Innkeeper told planning from building by each recipe's description.
One list of recipes, every one but those that choose a recipe, went to the Innkeeper, to every brewer with a `recipes` input and to every plan lens step, so the Brewmaster and `plan/recipe-fit` were shown `mash` and `decoction`, and `recipe-fit` was told to leave them out.
The check on a plan's sub-orders was a static schema, with no access to the Brewery's recipes.

## Decision
- **Every recipe has a required `type`, `mash` or `brew`** (`RecipeType`, `src/schemas/recipe.ts`).
  `mash` chooses a recipe or makes a plan and builds nothing; `brew` builds.
  A type arrives with its first recipe: there is no other, and no placeholder.
  A recipe file without one is refused when it loads, with a line that names the file and says to add `"type": "mash"` or `"type": "brew"`.
- **The defaults:** `mash-in`, `mash` and `decoction` are `mash`; `nip` is `brew`.
- **What each step is offered** (`loadRecipes`, `src/engine/recipe-files.ts`): a step that chooses the recipe gets every recipe but those that choose one, as before; a step whose brewer names the `recipes` input or writes a plan, or that reviews a plan, gets only the `brew` ones.
  The `recipes` input lists each as `- <name> (<type>): <description>`.
- **A plan's sub-orders run with those `brew` recipes.**
  A plan attempt's out doc is read against its step's offered recipes (`planOutDocOf`, `src/schemas/plan.ts`), as a recipe choice's question already is ([ADR 0232](0232-foedrum-mash-routes-an-issue-to-the-innkeeper-whose-question-the-answer-chooses-the-recipe-by.md)): a sub-order whose recipe is not one fails the attempt retryably, with the list.
  This replaces the refusal of the three names and moves the refusal of a name the Brewery lacks from the sub-order's start (`decide`'s `the Brewery has no recipe <name>`, after the plan's approval) to the plan's attempt; it adds no new kind of check.
  `PlanOutDoc` itself, which reads stored plans, no longer checks the recipe, so a plan stored before this change reads as it did.
- **The type is recorded when a recipe is chosen.**
  `batch.recipe_chosen` carries the chosen recipe's `recipeType`; the fold keeps it beside each attempt's recipe (`attemptRecipeTypeOf`, `src/engine/fold.ts`).
  `foedrum status <order>` counts an attempt's tokens as planning when that type is `mash`, so a recipe file changed, renamed or removed since the batch ran does not change what its attempts were.
  An event from before this change has no type: its attempts count as planning when their recipe is `mash`, `mash-in` or `decoction`, a frozen list used only for those (`PLANNED_BEFORE_TYPES`, `src/cli/status.ts`).
- **The Innkeeper tells planning from building by the type** and chooses among recipes of one type by their descriptions; its prompt's `version` is 6.

A type catches the wrong kind of recipe, not the wrong size: `nip` on an order too big for it still passes.

## Consequences
- A Brewery's own planning recipe is refused for a sub-order and counted as planning, whatever its name.
- The Brewmaster and the plan lenses no longer see recipes that plan, so `plan/recipe-fit` no longer has to be told to leave them out.
- A plan that names a recipe the Brewery lacks is sent back at its attempt, with the list, before a person reviews it.
- Recipes that are for no order at all (#921's `cleanup`, #625's and #284's `audit`) will bring their own type with their first recipe; until then the Innkeeper is offered every recipe that does not choose one.
- An older Foedrum cannot read a `batch.recipe_chosen` event with `recipeType` (its schema is strict), as with `askedBy` ([ADR 0232](0232-foedrum-mash-routes-an-issue-to-the-innkeeper-whose-question-the-answer-chooses-the-recipe-by.md)).

## Migration
A Brewery with recipe files of its own (`recipes/*.jsonc`):

1. Add `"type"` to each: `"mash"` for a recipe that chooses a recipe or makes a plan and builds nothing, `"brew"` for one that builds. A recipe such as a demo Brewery's `stout`, which brews a change and opens a pull request, is `"brew"`.
2. Run `foedrum doctor`: until each file has its type, it names every file without one, and `foedrum serve` refuses to start with the same line.
3. A Brewery with several drivers updates them together: an older Foedrum cannot read the events a newer one writes.

A Brewery with no recipe files of its own has nothing to change: the defaults carry their type.
Unfinished batches carry on after the upgrade; their attempts from before it count by the frozen list.

## Alternatives considered
- **Refuse only the names of the `mash` recipes for a sub-order**, the list replaced by the loaded types: keeps a second list beside the offered recipes, while the Brewmaster is offered only `brew` recipes anyway.
- **Look the type up in today's recipe files when `foedrum status` runs**: a removed or renamed recipe (#931 renames `decoction`) would count a finished plan's tokens as brewing.
- **Keep `PLANNING_RECIPES` beside the type**: two sources for one fact, and a Brewery's own planning recipe still unrecognised.
- **An optional type, defaulting to `brew`**: a Brewery's planning recipe would silently count as building, the gap this record closes.
