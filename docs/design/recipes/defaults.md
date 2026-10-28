# Defaults

## Default recipes

| Recipe | Use |
|---|---|
| Mash-in | the first step of a mash: the Innkeeper suggests one of the Brewery's other recipes and asks which brews the order; the answer chooses it; `foedrum mash` routes to it, nobody labels it; shipped in `defaults/recipes/mash-in.jsonc` ([ADR 0232](../../adr/0232-foedrum-mash-routes-an-issue-to-the-innkeeper-whose-question-the-answer-chooses-the-recipe-by.md)) |
| Nip | quick fix, test-first: the Gauger, a red proof, Cellarman, the Finer ([ADR 0166](../../adr/0166-the-finer-simplifies-a-batch-s-change-before-green.md)), the green checks (`build`, `typecheck`, `lint`, `format`, `test`; [ADR 0157](../../adr/0157-nip-s-green-step-runs-the-typecheck.md)) on the task tree with the base merged in ([ADR 0164](../../adr/0164-a-batch-merges-its-base-before-its-last-check.md)), then two Tasters side by side, through `diff/correctness` and `diff/acceptance` ([ADR 0197](../../adr/0197-acceptance-ships-as-a-default-diff-lens-and-nip-tastes-through-it-beside-correctness.md)), and the pull request; shipped in `defaults/recipes/nip.jsonc` with the default Gauger, Cellarman, Finer and Taster, which name the `builder` alias ([ADR 0100](../../adr/0100-nip-ships-with-a-default-cellarman-and-the-default-brewers-name-the-builder-alias.md)) |
| Half-pint | small feature |
| Pint | medium feature, with plan approval |
| Growler | large feature: decomposed into single-repository sub-orders, bottled per repository |
| Keg | multi-repository change with release dependencies between repositories |
| Pilot batch | spike / research, no PR |
| Infection check | triage of target-repository issues: reproduce, root cause, findings as Brewery orders ([target-repository issues](../intake/target-issues.md)) |
| Guest tasting | review someone else's pull request |
| Re-pitch | re-review a pull request after fixes |
| Refresh | dependency upgrades (scheduled) |

## Default brewers

Default models are aliases in `models.jsonc`, resolved to the current model of that family; blind tasting may propose changes.

| Brewer | Role | Model | Effort |
|---|---|---|---|
| Innkeeper | Reads an order and asks which recipe brews it, with a suggestion and the reason (read-only; [ADR 0232](../../adr/0232-foedrum-mash-routes-an-issue-to-the-innkeeper-whose-question-the-answer-chooses-the-recipe-by.md)) | builder (sonnet) | low |
| Maltster | Gathers context: relevant code, history, constraints | sonnet | high |
| Brewmaster | Writes the plan with acceptance criteria | opus | medium |
| Gauger | Writes failing tests (and minimal stubs, no implementation) from the order and plan | builder (sonnet) | high |
| Cellarman | Makes the Gauger's tests pass without changing them | builder (sonnet) | high |
| Finer | Simplifies the change without changing what it does, and commits it ([fining](fining.md)) | builder (sonnet) | high |
| Taster | Reviews a diff or a plan through its step's lens, or several together (read-only; [tasting](tasting.md)) | builder (sonnet) | medium |
| Brett | Mutation check: proposes plausible bugs; the engine confirms which ones the tests miss (advisory by default) | sonnet | medium |
| Cooper | Fixes review findings | sonnet | high |
| Blender | Resolves merge conflicts (bounded) | opus | medium |
| Microbiologist | Bug triage: reproduce, root cause, failing test | opus | medium |
| Lab tech | Verifies a fix in a real environment | sonnet | high |
| Tasting panel | Runs evaluations | — (uses the model under test) | — |

Shipped in `defaults/brewers/` so far: the Gauger, whose test rules are the test-design lens, passed in as `"from": "lens:diff/test-design"`, Cellarman, which also writes the pull request's sections (its out doc schema `pullRequest`, [ADR 0167](../../adr/0167-a-brewed-pull-request-follows-one-layout-and-opens-as-a-draft-unless-every-taster-approves.md)), the Finer, which simplifies the change before green ([ADR 0166](../../adr/0166-the-finer-simplifies-a-batch-s-change-before-green.md)), the Taster, which reviews through its step's lens and answers with findings and a verdict ([ADR 0161](../../adr/0161-lens-steps-run-a-taster-whose-findings-are-advisory-unless-the-step-blocks.md)), and the Innkeeper, which asks with the out doc schema `recipeChoice` among the recipes the engine fills its `"from": "recipes"` input with ([ADR 0232](../../adr/0232-foedrum-mash-routes-an-issue-to-the-innkeeper-whose-question-the-answer-chooses-the-recipe-by.md)), all on the alias `builder`, which Foedrum's `defaults/models.jsonc` maps to `sonnet` and a Brewery's `models.jsonc` may map to another model ([ADR 0153](../../adr/0153-foedrum-s-defaults-map-their-own-model-aliases.md), [ADR 0100](../../adr/0100-nip-ships-with-a-default-cellarman-and-the-default-brewers-name-the-builder-alias.md)).
Nip fines its change after Cellarman and, after its green checks, tastes through `diff/correctness` and `diff/acceptance` in a parallel group named `taste`, both advisory.
No default lens reports simplifications: a Taster after the Finer would review what the Finer did.
The others follow as the engine learns what they need.

Default lenses: [tasting](tasting.md).
