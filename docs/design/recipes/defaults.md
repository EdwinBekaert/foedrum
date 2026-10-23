# Defaults

## Default recipes

| Recipe | Use |
|---|---|
| Nip | quick fix, test-first: the Gauger, a red proof, Cellarman, the green checks (`build`, `typecheck`, `lint`, `format`, `test`; [ADR 0157](../../adr/0157-nip-s-green-step-runs-the-typecheck.md)), then the pull request; shipped in `defaults/recipes/nip.jsonc` with the default Gauger and Cellarman, which name the `builder` alias ([ADR 0100](../../adr/0100-nip-ships-with-a-default-cellarman-and-the-default-brewers-name-the-builder-alias.md)) |
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
| Innkeeper | Router: picks a recipe for an order (lean call) | haiku | low |
| Maltster | Gathers context: relevant code, history, constraints | sonnet | high |
| Brewmaster | Writes the plan with acceptance criteria | opus | medium |
| Gauger | Writes failing tests (and minimal stubs, no implementation) from the order and plan | builder (sonnet) | high |
| Cellarman | Makes the Gauger's tests pass without changing them | builder (sonnet) | high |
| Taster | Reviews a diff or a plan through one lens (read-only; [tasting](tasting.md)) | opus | medium |
| Brett | Mutation check: proposes plausible bugs; the engine confirms which ones the tests miss (advisory by default) | sonnet | medium |
| Cooper | Fixes review findings | sonnet | high |
| Blender | Resolves merge conflicts (bounded) | opus | medium |
| Microbiologist | Bug triage: reproduce, root cause, failing test | opus | medium |
| Lab tech | Verifies a fix in a real environment | sonnet | high |
| Tasting panel | Runs evaluations | — (uses the model under test) | — |

Shipped in `defaults/brewers/` so far: the Gauger, whose test rules are the test-design lens, passed in as `"from": "lens:diff/test-design"`, and Cellarman, both on the alias `builder`, which Foedrum's `defaults/models.jsonc` maps to `sonnet` and a Brewery's `models.jsonc` may map to another model ([ADR 0153](../../adr/0153-foedrum-s-defaults-map-their-own-model-aliases.md), [ADR 0100](../../adr/0100-nip-ships-with-a-default-cellarman-and-the-default-brewers-name-the-builder-alias.md)).
The others follow as the engine learns what they need.

Default lenses: [tasting](tasting.md).
