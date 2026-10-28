# 0253. A recipe's `match` is refused at load

Date: 2026-10-28 · Status: Accepted · Amends [0053](0053-recipe-files-reach-the-engine-brewer-steps-in-a-line-first.md) and [0194](0194-a-recipe-has-no-time-budget.md) (`match` goes, refused by name) and [0220](0220-a-taster-s-step-can-run-several-lenses-together.md) (`lensOfFinding` goes; the rule stands)

## Context
A recipe can hold `match: { labels }`, which ADR 0053 lets load and do nothing until a router is built, and ADR 0194 keeps as it is.
No router reads it: an order is routed by its `recipe:<name>` label ([ADR 0068](0068-the-intake-in-foedrum-serve-brewery-orders-and-routing-by-label.md)) or by `foedrum mash` ([ADR 0232](0232-foedrum-mash-routes-an-issue-to-the-innkeeper-whose-question-the-answer-chooses-the-recipe-by.md)).
The shipped Nip declares `"match": { "labels": ["quick-fix"] }`, so a person who labels an issue `quick-fix` after reading it gets an order Stuck on routing.
Every other field the engine does not follow is refused at load, as `budget` is (ADR 0194).

## Decision
- **`match` leaves the recipe.** The recipe schema has no `match`, and neither does Nip.
- **A recipe that still has it is refused, by name.** The schema refuses the field with one line that says how an order is routed (`a recipe has no "match" any more: remove it, an order is routed by its recipe:<name> label or by foedrum mash (ADR 0068, ADR 0232, ADR 0253)`), so the load (ADR 0053) and doctor name the file and the field.
- **`lensOfFinding` goes.** The lens report read only findings that the schema makes name their lens, so it reads `finding.lens`; the tasting comparison script writes the fallback where it reads a one-lens step. ADR 0220's rule stands: a finding without a lens is its step's lens's.

## Consequences
- The recipe file says only what the engine does: no field promises routing that is not there.
- A Brewery recipe written with `match` fails the load until the line is removed; one broken file stops every command that needs recipes (ADR 0053), and the line says what to do.
- Routing by a recipe's own labels can come back as a feature with a router that reads them, as a new decision.

## Alternatives considered
- **Keep the field and ignore it.** That is today's state: the file promises routing nobody does.
- **Build the router now.** Choosing a recipe from labels needs its own rules for overlaps and for orders that match none, for a case the `recipe:<name>` label and `foedrum mash` already cover.
- **Drop it from the schema and let the strict object refuse it as an unrecognized key.** The load would refuse it, but the line would not say how an order is routed instead.
