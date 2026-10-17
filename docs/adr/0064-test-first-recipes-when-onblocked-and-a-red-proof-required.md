# 0064. Test-first recipes reach the engine: when, onBlocked rounds, and a red proof required

Date: 2026-10-17 · Status: Accepted · Amends [0053](0053-recipe-files-reach-the-engine-brewer-steps-in-a-line-first.md)

## Context
[ADR 0017](0017-test-first-recipes-and-tasting-lenses.md) makes test-first a recipe structure: a Gauger step writes failing tests, a red proof (a check step with `"expect": "fail"`) shows they fail for the right reason, and Cellarman makes them pass. `testFirst` is recipe-level, decided by `resolveRecipe` when it is unset ([ADR 0028](0028-brewer-runner-outcomes-environment-and-test-first.md)), and the router may switch it off for an order whose change cannot be a failing test. Steps that only belong to test-first say `"when": "recipe.testFirst"`, and Cellarman's `"onBlocked": { "findings": … }` sends "this test is wrong" back to the Gauger.

[ADR 0053](0053-recipe-files-reach-the-engine-brewer-steps-in-a-line-first.md) made the recipe loader refuse a recipe that resolves to test-first until #25 lands, and refused `when` and `onBlocked` on brewer steps, because the engine did not follow them: the folded state had no record of a skipped step and could not tell the rounds of a route from retries.

A red proof is a check step, and a check reads the tree the earlier steps committed to. Each attempt still gets a new worktree from the repository's base (#168), so the engine cannot run a check step yet. #25 is therefore split: this decision covers what the engine can follow without a shared tree. The Gauger, the red proof read from the test report, the `testsUnchanged` guard and the check steps themselves move to #176.

## Decision

### A test-first recipe needs a red proof, for good
ADR 0053's refusal of every test-first recipe goes. In its place the loader keeps a lasting rule: a recipe that resolves to test-first loads only when it has a red proof, a step with `"expect": "fail"`, whose `of` names the first step with a brewer that produces `commits`, and when no other such step comes before the red proof (in the order `walk` gives, loop and parallel steps included). Otherwise it fails the load with one line:

- `it is a test-first recipe without a red proof: add a check step with "expect": "fail" whose "of" names the step that commits the failing tests, or set testFirst: false (ADR 0064)`;
- `step "<id>" commits before the red proof "<red>" of step "<of>" (ADR 0064)`, for each writing step that is not the proven one and comes first.

A test-first recipe that passes the rule still has a check step, which ADR 0053's line refuses by kind until the engine runs check steps (#176). A recipe that commits without a red proof loads only with `testFirst: false`, which now says in the file, for good, that it brews without one.

### when: the recipe's settings, read when the batch reaches the step
- A brewer step may have a `when` that reads the recipe's settings: `recipe.testFirst`, bare (true when the setting is) or compared with a value in single quotes (`recipe.testFirst == 'false'`, compared as text). A `when` that reads another step's result (`tasting.verdict`) is refused by name until the engine records the results it would read (#26): `step "<id>" has a "when" that reads step "<step>", which the engine does not follow yet (ADR 0064)`. A setting the recipe does not have is refused too: `step "<id>" has a "when" that reads recipe.<field>, which is not a recipe setting (ADR 0064)`.
- The batch's `testFirst` is the recipe's resolved value. The router's switch-off for one order (ADR 0017) joins with #176: until a test-first recipe loads, no batch brews one, so a switch-off could change nothing a test could show.
- `Recipe.skip(batch, stepId)` answers with the `when` that is false, or nothing when the step runs. `decide` asks when the batch reaches a step: its first step (routing, or a human's `recipe`), and the step after one that succeeded, was skipped, or was skipped by a human. A skipped step is recorded as **`step.skipped`** `{ batchId, stepId, when }`, and the batch goes on to what follows it, on tap when nothing does. A human's `retry` or `answer` names its step and schedules it without asking, and a `rewind` goes only to a step that ran (ADR 0025), so never to one the batch skipped.
- The fold keeps the steps whose latest record is a skip (`Batch.skipped`); scheduling a step takes it out, and a new recipe empties the set. An input from a skipped step (`"from": "step:<id>"`) is left out of the next attempt's plan, so Cellarman without a Gauger gets no `tests` input (brewers-and-recipes §3).
- `step.skipped` moves the batch to Brewing, as `step.scheduled` does, and is admitted in the same lanes.

### onBlocked: rounds recorded on the schedule
- A brewer step may have `"onBlocked": { "findings": { "goto", "maxRounds" } }`. When its attempt ends `blocked` + `findings`, `loopBack` answers with the `goto` step while the route has been taken fewer than `maxRounds` times, and the batch goes back there; after that it is Stuck on the blocker, as before. `environment` and `divergence` blockers are always Stuck (brewers-and-recipes §2).
- The attempt a route schedules records it: `step.scheduled` gets an optional `route: { from, why }` (`why`: `failed` for an `onFail` route, `findings` for an `onBlocked` one). The rounds a route used are the attempts of its `goto` step scheduled by it, over the batch's whole life, as attempts are counted (ADR 0053): a human's `retry` after the rounds ran out gives the step one more attempt, not another round.
- A route back to a step the batch skipped makes it Stuck (`blocked`, `divergence`) instead of jumping: `step "<from>" routes back to step "<goto>", which was skipped`. With `testFirst` off, "this test is wrong" therefore goes to a human.
- `onFail` follows the same rule and record once check steps run (#176).

## Consequences
- Every place that reads the event log learns `step.skipped` and the `route` of a schedule; both are additive, so existing logs and state branches still fold.
- Until #176, no test-first recipe loads: each has a red proof, which is a check step. What changes for a Brewery now is the message, which names what is missing instead of pointing at #25, and that `when` and `onBlocked` brewer steps load.
- Recipes that set `testFirst: false` because they commit without a red proof keep it, for that reason (the integration recipe of #148 among them).
- A recipe step whose `when` reads a step result, `lens`, `blocking`, and every kind other than brewer steps are still refused by name.

## Alternatives considered
- **Lift the refusal and nothing else.** A writing recipe without a Gauger and a red proof would brew as test-first while being nothing of the kind, which is what ADR 0053 refused.
- **Count rounds from the blocked attempts' reasons.** No new field, but it parses the text `decide` writes, and a reason is for people.
- **Keep skipped steps as steps with no attempts.** Every reader that takes a step's latest attempt would have to handle a step with none; a set of its own on the batch keeps them apart.
- **Evaluate `when` when a step is scheduled by a human too.** A human who retries a step means that step; skipping it would ignore the command.
- **The router's switch-off now.** It is a field on `batch.recipe_chosen` that `when` reads, but with no test-first recipe loadable, no test could show it switching anything off; it lands with #176.
