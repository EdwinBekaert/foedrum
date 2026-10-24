# Defaults

## Default recipes

| Recipe | Use |
|---|---|
| Nip | quick fix, test-first: the Gauger, a red proof, Cellarman, the Finer ([ADR 0166](../../adr/0166-the-finer-simplifies-a-batch-s-change-before-green.md)), the green checks (`build`, `typecheck`, `lint`, `format`, `test`; [ADR 0157](../../adr/0157-nip-s-green-step-runs-the-typecheck.md)) on the task tree with the base merged in ([ADR 0164](../../adr/0164-a-batch-merges-its-base-before-its-last-check.md)), then the Taster through `diff/correctness` and the pull request; shipped in `defaults/recipes/nip.jsonc` with the default Gauger, Cellarman, Finer and Taster, which name the `builder` alias ([ADR 0100](../../adr/0100-nip-ships-with-a-default-cellarman-and-the-default-brewers-name-the-builder-alias.md)) |
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
| Finer | Simplifies the change without changing what it does, and commits it ([fining](fining.md)) | builder (sonnet) | high |
| Taster | Reviews a diff or a plan through one lens (read-only; [tasting](tasting.md)) | builder (sonnet) | medium |
| Brett | Mutation check: proposes plausible bugs; the engine confirms which ones the tests miss (advisory by default) | sonnet | medium |
| Cooper | Fixes review findings | sonnet | high |
| Blender | Resolves merge conflicts (bounded) | opus | medium |
| Microbiologist | Bug triage: reproduce, root cause, failing test | opus | medium |
| Lab tech | Verifies a fix in a real environment | sonnet | high |
| Tasting panel | Runs evaluations | — (uses the model under test) | — |

Shipped in `defaults/brewers/` so far: the Gauger, whose test rules are the test-design lens, passed in as `"from": "lens:diff/test-design"`, Cellarman, which also writes the pull request's sections (its out doc schema `pullRequest`, [ADR 0167](../../adr/0167-a-brewed-pull-request-follows-one-layout-and-opens-as-a-draft-unless-every-taster-approves.md)), the Finer, which simplifies the change before green ([ADR 0166](../../adr/0166-the-finer-simplifies-a-batch-s-change-before-green.md)), and the Taster, which reviews through its step's lens and answers with findings and a verdict ([ADR 0161](../../adr/0161-lens-steps-run-a-taster-whose-findings-are-advisory-unless-the-step-blocks.md)), all on the alias `builder`, which Foedrum's `defaults/models.jsonc` maps to `sonnet` and a Brewery's `models.jsonc` may map to another model ([ADR 0153](../../adr/0153-foedrum-s-defaults-map-their-own-model-aliases.md), [ADR 0100](../../adr/0100-nip-ships-with-a-default-cellarman-and-the-default-brewers-name-the-builder-alias.md)).
Nip fines its change after Cellarman and tastes through `diff/correctness` after its green checks, advisory.
No default lens reports simplifications: a Taster after the Finer would review what the Finer did.
The others follow as the engine learns what they need.

Default lenses: [tasting](tasting.md).
