# 0194. A recipe has no time budget

Date: 2026-10-25 · Status: Accepted · Amends [0053](0053-recipe-files-reach-the-engine-brewer-steps-in-a-line-first.md) (`budget` goes; `match` stays as it is) and [0168](0168-a-parallel-group-runs-its-lens-steps-side-by-side.md) (a parallel group's time counts against nothing)

## Context
A recipe can hold `budget: { minutes }` (brewers-and-recipes §3), and Nip sets 30 minutes.
ADR 0053 lets it load and do nothing, since no budget was built, and ADR 0168 says a parallel group's children would count their time toward it, summed, once it lands (#445).
Nothing reads the field, so a recipe author who sets it believes in a limit that does not exist.

A batch is already bounded without it: each attempt has a deadline and a stall limit (ADR 0027), a brewer has `maxTurns`, resumed once when it runs out (ADR 0175), and `maxAttempts` caps how often a step runs before the batch becomes Stuck.
The brews so far used 4, 14 and 26 minutes of brewer time against Nip's 30: no batch came near a limit the other bounds did not already set.

## Decision
- **`budget` leaves the recipe.** The recipe schema has no `budget`, and neither do Nip nor the demo's recipe.
- **A recipe that still has it is refused, by name.** The schema refuses the field with one line that says it is gone (`a recipe has no "budget" any more: remove it, each step's deadline, stall limit and attempts bound the batch (ADR 0194)`), so the load (ADR 0053) and doctor name the file and the field instead of passing it silently or calling it an unknown key.
- **A parallel group's time counts against nothing.** Each child keeps its own deadline and stall limit (ADR 0168); no sum is kept.
- **`match` is unchanged:** it loads and does nothing until the router is built (ADR 0053).

## Consequences
- The recipe file says only what the engine does: no field promises a limit that is not there.
- A Brewery recipe written with `budget` fails the load until the line is removed; one broken file stops every command that needs recipes (ADR 0053), and the line says what to do.
- A batch-wide time limit, if one is ever needed, comes back as a new decision with the observed failure it answers.

## Alternatives considered
- **Build the budget.** A wall-clock or summed limit across attempts would need its own events, a Stuck reason and a rule for retries and rewinds, to catch a case the attempt deadlines, stall limits, `maxTurns` and `maxAttempts` already bound.
- **Keep the field and ignore it.** That is today's state: the file promises a limit nobody enforces.
- **Drop it from the schema and let the strict object refuse it as an unrecognized key.** The load would refuse it, but the line would not say the field was removed on purpose or what bounds a batch instead.
