# 0375. Every recipe offered as a choice carries guidance the models that choose read

Date: 2026-11-11 · Status: Accepted · Amends [0232](0232-foedrum-mash-routes-an-issue-to-the-innkeeper-whose-question-the-answer-chooses-the-recipe-by.md) and [0365](0365-a-recipe-has-a-type-mash-or-brew.md) (what the recipes input lists, and the Innkeeper chooses among recipes of one type by their guidance, not their description), [0234](0234-the-brewmaster-writes-a-plan-on-the-planner-alias-and-mash-runs-it.md) (the Brewmaster chooses a sub-order's recipe by its guidance), [0321](0321-mash-and-decoction-review-a-plan-through-the-plan-lenses-apart.md) (`plan/recipe-fit` judges a sub-order's recipe by its guidance, not its size) and [0366](0366-deep-brew-builds-a-change-that-can-reach-a-lot-through-every-diff-lens-and-a-blocking-brett-step.md) (the Innkeeper no longer suggests a `brew` recipe for a small, clear order)

## Context
A recipe carried one `description`, and it was all a model read to choose one.
The Innkeeper was told to judge an order's size and to suggest a recipe of type `brew` "for a small, clear order" ([ADR 0365](0365-a-recipe-has-a-type-mash-or-brew.md)); the Brewmaster was told that a recipe such as `nip` is "for a small, test-first change"; and the `plan/recipe-fit` lens called a recipe too light when an entry's `size` called it large, and too heavy for an entry of a few lines.
`nip`'s description was "Quick fix in one repository, test-first", with nothing on when not to choose it.
Order #867 was a small fix in the driver's loop over every batch: it got `nip`, all three Tasters approved it, and a later review found that the fix alone would not stop the error, and a bug the fix made reachable ([ADR 0366](0366-deep-brew-builds-a-change-that-can-reach-a-lot-through-every-diff-lens-and-a-blocking-brett-step.md)).
The maintainer decided on #977 (2026-11-10) that every recipe says what it does, when to choose it and how it is best used, that the model that chooses reads it, and that a recipe follows what a change can reach, not its size; it is guidance, and a person still confirms the choice (`foedrum mash`'s question, a plan's approval).
On 2026-11-11 the maintainer decided that the guidance is required of every recipe offered as a choice.

## Decision
- **A recipe has `guidance` beside its `description`** (`RecipeGuidance`, `src/schemas/recipe.ts`): `chooseWhen`, the orders it is for; `notWhen`, the orders it is not for and what to choose for them; and `bestUsed`, how it is best used.
  The `description` stays what the recipe does.
  Each of the three is one line, without a line feed, a carriage return, U+2028 or U+2029, since a line break would forge a line of the recipes input it is shown in, and at most 300 characters.
- **Every recipe offered as a choice must carry it.** `loadRecipes` checks it where it builds the choices, every recipe but those that choose a recipe ([ADR 0232](0232-foedrum-mash-routes-an-issue-to-the-innkeeper-whose-question-the-answer-chooses-the-recipe-by.md)), and refuses one without it with a line that names its file and the three fields to add; `foedrum doctor` and `foedrum serve`'s setup show the same line, as they show a recipe without its type ([ADR 0365](0365-a-recipe-has-a-type-mash-or-brew.md)).
  A recipe that chooses a recipe, such as `mash-in`, is never offered, so it needs none and no exemption names it.
- **The recipes input shows it** (`recipesInput`, `src/brewers/attempt-plan.ts`): under each recipe's line, `- <name> (<type>): <description>`, three lines, `  Choose when: …`, `  Not when: …` and `  Best used: …`.
  With the default recipes the Innkeeper's input grows from 395 characters to 2,543, and the Brewmaster's and a plan lens's from 172 to 1,316 (counted on the defaults before and after this change).
- **The default recipes carry it.** `nip`'s `notWhen` says it is not for a change that can reach a lot, however small, such as a loop over every item, a shared path, a public interface, a credential, a migration or what other repositories read, and names `deep-brew` for it; `deep-brew`'s `chooseWhen` is that change, whatever its size; `mash`'s and `deep-mash`'s tell a plain cut from one whose risk a quick plan can miss.
  No default description names a size any more: `nip`'s says it builds a change in one repository, test-first, through four diff lenses, where it said "quick fix", and `deep-mash`'s is a careful plan of an order whose cut carries a risk, where it said "a large order".
- **The Innkeeper, the Brewmaster and `plan/recipe-fit` choose and judge by it, by what a change can reach and never by its size.**
  The Innkeeper (version 8) reads as much of the repositories as it needs to judge what a change can reach, tells planning from building by the type, and chooses among recipes of one type by their guidance: a small change that can reach a lot is not a small order.
  The Brewmaster (version 8) chooses each sub-order's recipe by the guidance and what the sub-order can reach, and says in `why` what it reaches that the guidance fits.
  `plan/recipe-fit` calls a recipe too light when its `notWhen` covers what an entry can reach, however few lines, and too heavy when the entry meets none of its `chooseWhen` while another recipe's fits; a lens file carries no version, so none is raised.

## Consequences
- A model choosing a recipe reads when not to choose it, so `nip` on a change like #867's is a choice against its own guidance, which `plan/recipe-fit` can name and a person sees in the Innkeeper's reason.
- A Brewery's own recipe that is offered states when to choose it, or the Brewery does not load.
- The recipes input costs 2,148 more characters per Innkeeper attempt and 1,144 more per Brewmaster or plan lens attempt with the defaults.
- Recording when a recipe was the wrong choice is #908's, not this record's.

## Migration
None: Foedrum has no release.

## Alternatives considered
- **A longer text the recipe file points to**: a new kind of Brewery file to find, read and refuse when missing, and free-form Markdown inside the input with no line of its own per question, for three short answers.
- **A fourth field for what the recipe does**: the `description` already says it.
- **Optional guidance, a recipe without it offered by its description**: a Brewery's own recipe would be chosen without saying when not to, the gap #867 showed (the maintainer's choice, 2026-11-11).
- **Choose the recipe by a size rule or a list of paths**: the maintainer chose guidance a model reads and a person confirms ([ADR 0366](0366-deep-brew-builds-a-change-that-can-reach-a-lot-through-every-diff-lens-and-a-blocking-brett-step.md)).
