# 0305. A step: input of a step the recipe lacks is left out

Date: 2026-11-02 · Status: Accepted · Amends [0059](0059-attempt-plans-from-the-brewer-of-the-step.md) (a `step:` input of a step the recipe lacks no longer refuses the plan), [0064](0064-test-first-recipes-when-onblocked-and-a-red-proof-required.md) (it is left out, as a skipped step's is) and [0294](0294-npm-run-demo-ladder-walks-an-order-across-two-repositories.md) (the ladder recipe has no gauge step)

## Context
[ADR 0059](0059-attempt-plans-from-the-brewer-of-the-step.md) reads a `step:<id>` input as the out doc of that step's latest attempt that succeeded: "a step with none refuses the plan".
[ADR 0064](0064-test-first-recipes-when-onblocked-and-a-red-proof-required.md) made one exception: an input of a step the batch skipped is left out, so the Cellarman runs without `tests` in Nip with `testFirst` off.
A step the recipe does not have at all still refused the plan.
The default Cellarman declares `{ "name": "tests", "from": "step:gauge" }`, so a Brewery recipe of a Cellarman and a pull request, with no Gauger, went Stuck at its first attempt, before any brewer started (#774).
The ladder demo ([ADR 0294](0294-npm-run-demo-ladder-walks-an-order-across-two-repositories.md)) worked around it with Nip's gauge step under `recipe.testFirst`, skipped.
A recipe without a Gauger is legitimate, and the Cellarman's prompt already says what to do without tests.

## Decision
- **An input of a step the recipe lacks is left out.** A `step:<id>` input whose id is no step or group of the batch's recipe gives the brewer nothing, as a skipped step's does: its prompt has no section for it.
- **An input that names a step of no brewer is refused.** When the recipe has a step or group of that id but no brewer runs it (a check, an action, a group), the attempt fails: `the input "<name>" names step <id>, which is no brewer's step and has no out doc`. Such an input is a mistake in the brewer's file, and it fails loudly as before, with its own reason.
- **A brewer's step with no succeeded attempt still refuses the plan**, as ADR 0059 has it: an ordering fault, not a missing step.
- **`StepBrewers.has(recipe, id)`** says whether the loaded recipe has a step or group of that id, read from the recipe's own `has`; `createAttemptPlans` passes it to `inputsOf`, beside the brewer lookup, both in the batch's recipe.
- `plan`, `plan-entry`, `release`, `lens:` and `file:` inputs are unchanged.
- **No load rule.** The loader does not refuse a brewer whose `step:` input no recipe that uses it has, so a misspelt id (`step:guage`) now drops the input without a word. Checking it needs every brewer's inputs held against every recipe that uses the brewer, and no failure has been observed that it would catch.
- **The ladder recipe** is the Cellarman, then `openPullRequest`, with no gauge step.

## Consequences
- A Brewery recipe of a Cellarman and a pull request, with no Gauger, brews instead of going Stuck at its first attempt.
- A brewer can declare an input of a step only some of the recipes that run it have, and read it where it is.
- A typo in a `step:` input's id is no longer caught at the attempt; the brewer runs without that input.
- The brewer and the step lookups read the batch's current recipe, not the recipe the attempt was scheduled under; that is #786.
