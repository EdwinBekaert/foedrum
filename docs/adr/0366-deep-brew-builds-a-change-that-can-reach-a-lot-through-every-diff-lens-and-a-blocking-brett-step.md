# 0366. Deep-brew builds a change that can reach a lot, through every diff lens and a blocking Brett step

Date: 2026-11-10 · Status: Accepted · Amends [0319](0319-brett-s-survivors-are-listed-where-findings-are-and-a-blocking-brett-step-sends-them-back.md) (a default recipe runs Brett, blocking, its survivors sent back to the Gauger), [0224](0224-the-default-recipes-taste-apart-or-together-as-a-seeded-comparison-measured.md) (a default recipe tastes its lenses together), [0358](0358-an-older-test-changes-only-in-the-gauger-s-red-commit.md) (the Gauger a Brett step sends back adds a test per survivor), [0352](0352-nip-s-correctness-acceptance-and-security-tasters-run-at-high-effort-without-the-rules-read.md) (three setups of `tasting-compare --real` taste with the default Taster, not the pinned one), [0347](0347-tasting-compare-real-measures-tasters-without-the-rules-read-and-three-lenses-together.md) (three more setups of `tasting-compare --real`) and [0344](0344-tasting-compare-real-measures-a-stronger-model-and-more-effort-apart.md) (`--orders` beside `--setups`)

## Context
Foedrum ships one recipe that builds, `nip`, so every change is built and reviewed by it, however much it can reach.
`nip` tastes through four of the seven diff lenses (correctness, acceptance, security and design conformance, [ADR 0343](0343-nip-tastes-through-design-conformance-as-a-fourth-advisory-lens.md)); no shipped recipe runs cross-platform, necessity or test design, and none runs Brett ([ADR 0319](0319-brett-s-survivors-are-listed-where-findings-are-and-a-blocking-brett-step-sends-them-back.md)), so mutants run only in `/brew-review`.
On #867, `nip` built and approved a change in which `/brew-review` then found a filter that reads a value outside its guard, a new failure outcome with no decision record, that the fix alone would not stop the error, and a mutant that survived all 231 tests.
In the two self-brews of #957, `/brew-review`'s test-design lens found a line only one test reached, which none of `nip`'s four Tasters raised.
The design page listed `half-pint`, `pint` and `growler`, none shipped, all named by size.

The maintainer settled the recipe on #915 (2026-11-10).
The full recipe has four stages, each added by its own issue: readiness (#373), the build (this record), the proof that the change works (#762) and the documentation (#971).

## Decision
- **`deep-brew` ships** (`defaults/recipes/deep-brew.jsonc`, type `brew`, [ADR 0365](0365-a-recipe-has-a-type-mash-or-brew.md)): the full recipe's build stage, for a change that can reach a lot, whatever its size. A person labels an order `recipe:deep-brew`, and a sub-order may name it.
  It is chosen by what a change can reach, never by its size: its `description` says so, and the Innkeeper, the Brewmaster and `plan/recipe-fit` read it; a person confirms the choice. What every recipe does, when to choose it and how it is best used is #977's.
  Until #977 lands, the Innkeeper's prompt still suggests a recipe of type `brew` for a small, clear order, so it may suggest `nip` for a large, clear order that can reach a lot; a person then answers its question with `deep-brew`, or labels the order `recipe:deep-brew`.
- **Its steps are `nip`'s, from the Maltster's survey to green**, with the same brewers, checks and routes: `survey`, `survey-check`, `gauge`, `red`, `implement` (its findings back to the Gauger once), `fine`, `green` (a failure back to Cellarman once).
- **Then a blocking Brett step**, `mutants`, whose `onBlocked` findings route goes to `gauge`, twice at most in each run of the recipe ([ADR 0369](0369-a-recipe-s-routes-count-their-rounds-per-run-an-open-pull-request-s-over-the-batch-s-life.md)).
  Each surviving mutant is a `major` finding ([ADR 0319](0319-brett-s-survivors-are-listed-where-findings-are-and-a-blocking-brett-step-sends-them-back.md)).
  The Gauger's round starts at its own latest success, without the code ([ADR 0358](0358-an-older-test-changes-only-in-the-gauger-s-red-commit.md)), and adds the tests that catch the survivors; the red proof checks they fail; Cellarman writes the code again from the red proof's tip, through the Finer and green, and Brett runs again.
  So every test stays before the code in the history.
  After two rounds the batch is Stuck with the survivors open ([ADR 0192](0192-a-findings-route-that-runs-out-of-rounds-goes-stuck-with-the-open-findings.md)).
  Brett's route and Cellarman's own route to the Gauger count their rounds apart.
- **The default Gauger adds a test per survivor.** Its prompt says that when `{route}` lists mutants the tests let survive, it adds a test for each that fails for the missing behaviour and would catch the mutant once the code is written, reading the mutant's line in `{route}`, since its worktree has no code; its `version` is 13.
  `nip` never sends a Brett route, so its runs do not change.
- **Then one Taster through all seven diff lenses together** ([ADR 0220](0220-a-taster-s-step-can-run-several-lenses-together.md)), the step `taste`, on the `planner` alias, at the Taster's own effort, every finding going back to Cellarman, twice at most in each run ([ADR 0354](0354-every-finding-of-a-taster-goes-back-along-one-on-findings-route.md)), and then the pull request, whose failing checks go back to Cellarman twice at most, as `nip`'s do ([ADR 0219](0219-a-failing-check-on-an-open-pull-request-sends-its-batch-back-to-a-fix-step.md)).
  On #867 it was the only setup measured that found more: 2.0 per run against 1.5 for `nip`'s four Tasters and for seven Sonnet Tasters apart, at about 1.4 times `nip`'s review cost, with Opus at twice Sonnet's price per token (Measured, below).
  Background: on #879's heads, three lenses together on Opus found the main defect in 3 of 3 runs, as three Sonnet Tasters apart did, and three together on Sonnet in 1 of 3 (#936).
  That was at the Taster's medium effort, so `deep-brew` names no effort.
- **Brett before the Taster.** A survivor round writes the code again from the red proof's tip, so a Brett step after the Taster would throw away the Taster's fixes in every survivor round.
  Before it, the expensive Opus Taster runs only once the survivors are settled, and it reviews the tests their round added.
  A Taster's fix round followed by a new survivor still writes the code once more: a Taster's round back runs Brett again, and a survivor then sends the batch to the Gauger, at most twice in all.
- **`tasting-compare --real` measures it** ([ADR 0332](0332-tasting-compare-real-re-tastes-brewed-heads-and-writes-blinded-lists.md)).
  Its `deep` setup tastes as `deep-brew` ships its Taster, its `nip` setup as `nip` ships its four, and its `apart7` setup as `nip` ships its four with test design, cross-platform and necessity as three more Sonnet Tasters beside them at the Taster's own effort, each with the default Taster and models.jsonc, not the pinned Taster that reads the rules ([ADR 0352](0352-nip-s-correctness-acceptance-and-security-tasters-run-at-high-effort-without-the-rules-read.md)): they measure what the defaults run today, and a test holds each to its recipe file.
  `--orders <numbers>` runs only the setups `--setups` names of those orders.
  The order is #867 at `nip`'s head on #868, `f4fb4585`, already the comparison's third order: the pull request opened at 20:23 after that commit, and the first `/brew-review` summary names it as the head it reviewed, before the review's first fix.
  Its key is the four findings above, kept out of the repository; the lists are scored blind.

## Measured
Measured on 2026-11-10 with `--real --orders 867 --runs 3`, one tasting round per run, the lists scored blind against a key that stays out of the repository: `/brew-review`'s findings on #868 at `f4fb4585`.
Its three majors are K1, a filter that reads a value outside its guard, K2, a pass over the batches that is not isolated, and K3, a new failure with no decision record and nothing that decides how the batch ends; K4 to K10 are minors, among them K8, a test that looks only for the old failure and cannot see the fix.
A finding the scorer judged part of a key item counts 0.5.

| Setup | Tasters | Score per run | Mean | Tokens per run | Mean |
|---|---|---|---|---|---|
| `nip` | four on Sonnet, as `nip` ships them | 1.5, 1.5, 1.5 | 1.5 | 1,509k, 1,605k, 1,620k | 1,578k |
| `apart7` | `nip`'s four and test design, cross-platform and necessity apart, on Sonnet | 1.5, 1.0, 2.0 | 1.5 | 1,416k, 1,804k, 1,522k | 1,581k |
| `deep` | one on Opus through all seven lenses, as `deep-brew` ships it | 2.0, 2.0, 2.0 | 2.0 | 943k, 1,307k, 1,036k | 1,095k |

- Every setup found K1 in 3 of 3 runs.
- `deep` alone found K8, in 3 of 3; `nip` found part of K3 in 3 of 3 (the missing record, not the batch's end), `apart7` in 2 of 3, and `deep` in none.
- No run found K2 whole: `apart7` found part of it in 1 of 3. No run found K4 to K7, K9 or K10, and no run wrote a false finding.
- `apart7`'s three more Tasters opened no file beyond the diff in 8 of their 9 attempts, ending in 2 to 5 turns, and wrote 1 finding in all: tasted apart on Sonnet, the extra lenses added almost nothing and cost almost nothing.
- Cost: with Opus at twice Sonnet's price per token, `deep`'s 1,095k Opus tokens cost about 1.4 times `nip`'s 1,578k Sonnet tokens per tasting round.
- The `nip` that brewed #867 on 2026-11-05, with three Tasters, approved it with no finding.
- It is one head and three runs per setup: a difference of one run is within what a repeat could change. The maintainer chose `deep` on these numbers.

Tokens per batch are an estimate until a real `deep-brew` batch runs, which the maintainer does after the merge.
The eight `nip` batches of the self-brew trial in the maintainer's Brewery used 1.10M to 22.5M tokens each, a median of about 2.4M; the store's 35 Taster attempts averaged about 143k, about 0.57M for `nip`'s four.
So a `deep-brew` batch with no round back is about 2.4M − 0.57M + 1.10M for its Taster + about 0.2M for Brett ≈ 3.1M; Brett's share is a guess, since no Brett step has run in a Brewery yet, and its test runs spend no tokens.
On #867 `nip`'s four Tasters measured 1.58M, well above that average, so on such a head `deep-brew`'s tasting uses fewer tokens than `nip`'s, yet costs about 1.4 times as much, its tokens being Opus's.

## Consequences
- An order that can reach a lot gets every diff lens and Brett's mutants in the engine, as `/brew-review` gives Foedrum's own pull requests.
- A survivor round costs a Gauger attempt, a red proof, Cellarman writing the code again, the Finer, green and Brett again; a Taster round back costs Cellarman, the Finer, green, Brett and the Taster again.
- A Brett run takes the repository's whole test check once as a baseline and once per valid mutant, at most five, within Brett's 20-minute deadline ([ADR 0313](0313-the-engine-runs-brett-s-mutants-in-scratch-trees-against-a-fresh-baseline.md)).
- The design page's `half-pint`, `pint` and `growler` rows are gone: a recipe follows what a change can reach, not its size.
- `tasting-compare --real` has two more setups for each order.

### Migration
None needed. A Brewery that names no `deep-brew` brews as before, and a Brewery with its own recipes keeps them; one with its own `deep-brew.jsonc` keeps it, since a Brewery file of the same name replaces the default ([ADR 0098](0098-foedrum-s-defaults-load-under-the-brewery-s-files-and-a-brewer-input-can-name-a-lens.md)).
A Brewery with its own Gauger that uses `deep-brew` should add the default Gauger's sentence on surviving mutants; without it, its Gauger may end blocked or add nothing, and the survivor comes back until the route's rounds run out.
`foedrum doctor` has nothing to name: every file that loaded still loads.

## Alternatives considered
- **Brett after the Taster.** Each survivor round would throw away the Taster's fixes, since the code is written again from the red proof's tip.
- **Survivors back to Cellarman.** Cellarman may not change a test file the base holds ([ADR 0358](0358-an-older-test-changes-only-in-the-gauger-s-red-commit.md)), and a test it adds would come after the code in the history.
- **Seven Tasters apart, on Sonnet** (the `apart7` setup). On #867 it scored as `nip` did (1.5 per run) at the same cost, its test-design Taster missed the test that cannot see the fix in 3 of 3 runs, which `deep` found in 3 of 3, and its three added Tasters opened no file beyond the diff in 8 of their 9 attempts.
- **The lenses together on Sonnet.** Three together on Sonnet lost the main defect in 2 of 3 runs on #879's heads (#936).
- **Brett inside the taste group.** A parallel group runs only Tasters ([ADR 0168](0168-a-parallel-group-runs-its-lens-steps-side-by-side.md)).
- **Choose the recipe by a list of paths or a size rule.** The maintainer chose guidance a model reads and a person confirms (#977).
