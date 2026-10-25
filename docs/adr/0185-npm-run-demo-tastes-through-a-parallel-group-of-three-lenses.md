# 0185. `npm run demo` tastes through a parallel group of three lenses

Date: 2026-10-25 · Status: Accepted · Amends [0139](0139-npm-run-demo-brews-with-nip-and-shows-foedrum-brew-and-foedrum-resume.md) (the recipe the demo brews with, and what its Taster's script plays)

## Context
Since [ADR 0168](0168-a-parallel-group-runs-its-lens-steps-side-by-side.md) a recipe can run Tasters' lens steps side by side in a `parallel` group, but `npm run demo` never shows it: it brews with Nip from `defaults/`, which tastes through one lens (ADR 0161).
#428 left Nip as it is, so that no Nip batch pays for two more Taster runs, and #448 asks the demo to show the group without changing Nip.

## Decision
- **The demo Brewery has a recipe of its own, `nip-parallel`** (`recipeText` in `scripts/demo/core.ts`, written to the scratch Brewery's `recipes/`): Nip's steps, with its `taste` step a `parallel` group of three lens steps, `correctness` (`diff/correctness`), `security` (`diff/security`) and `test-design` (`diff/test-design`). Its brewers and lenses still come from Foedrum's defaults (ADR 0098), and Nip in `defaults/` stays as it is. A unit test holds the recipe's steps to Nip's, read from `defaults/recipes/nip.jsonc`, with the taste step replaced, so the two stay in step.
- **Both orders are labelled `recipe:nip-parallel`**, the Cellar's from the start and `foedrum brew`'s once the Cellar has stopped, as before.
- **The demo's brewer plays a Taster for each lens step**: `DEMO_SCRIPT` in `scripts/demo/brewer.ts` is the Nip fixture's script with one approving out doc per child, each with a minor finding of its own, the correctness one the fixture's Taster's. The fixture's `scriptedNip` takes the script as an option (`NIP_SCRIPT` by default, for the E2E test and `foedrum brew`'s test), and writes each attempt's out doc to the file its limits name, the brewer's `output.doc`, instead of a list by step id.
- **The walkthrough keeps its ten steps**; what to look for says that `foedrum status` shows the three lens attempts brewing at once once `green #2` passes, and that the status comment's path line has them side by side and its findings each one's under its own step. The integration test checks the three `step.started` events before any of their `step.finished`, that `foedrum status` line, the path line and a finding line per child.

## Consequences
- The demo shows a parallel group with no change to the engine, Nip or the default brewers: three more Taster attempts, which the scripted brewer plays at once, and no model.
- `foedrum brew`'s integration test (`test/integration/brew.test.ts`), which brews the demo's Brewery, brews `nip-parallel` with `DEMO_SCRIPT` too; the E2E test (`test/integration/nip.test.ts`) still brews Nip from `defaults/` with the fixture's own script.
- The demo no longer brews with a recipe from `defaults/` as it is: a change to Nip's steps fails the recipe's unit test until `recipeText` follows.
- The path line lists attempts in the order they started, so the comment's last revision shows the three side by side, not that they overlapped; the overlap shows in `foedrum status` while they brew, and in the store's events (`foedrum replay`).

## Alternatives considered
- **A parallel group in Nip itself.** Every Nip batch would pay for three Taster runs, which #428 ruled out.
- **The recipe as a file under `scripts/demo/`.** Easier to read, but a second copy of Nip's steps that nothing checks; built in the core, it is written to the scratch Brewery, where a user reads it, and a unit test holds it to Nip's.
- **A walkthrough step of its own for the group.** The group runs between the checks and the pull request, whose steps already show its status lines and its comment; an eleventh step would only split the Cellar's output once more.
