# Interactive refinement

Good automation starts with a sharp breakdown.
Analysis and decomposition are where a human adds the most value, so Foedrum offers them interactively ([ADR 0014](../../adr/0014-interactive-refinement-plugin.md)):

- A small **Claude Code plugin** provides `/foedrum:refine #<order>`.
  You run it in your own interactive Claude Code session, investigate the order together with Claude — across the registered repositories, read-only — and steer until the path is obvious.
- When you are satisfied, the plugin writes the result into the Brewery: the analysis as an out doc on the state branch, the sub-orders as sub-issues with dependencies, and a plan per sub-order.
  The breakdown counts as approved; Foedrum starts brewing.
- Re-running `/foedrum:refine` on an order that already has sub-orders shows the current breakdown and lets you deepen, add or cancel sub-orders (never silently delete).
- The plugin is Markdown commands and skills only — no npm packages — and talks to the Brewery through the `foedrum` CLI.

Since [ADR 0222](../../adr/0222-a-recipe-s-brewer-step-may-be-interactive.md), a recipe asks for a person in the conversation with an interactive brewer step, which runs as that brewer's session in `foedrum brew`'s terminal ([interactive steps](../recipes/interactive-steps.md)); ADR 0019's fixed `session` kinds (refine, triage, review) are gone.
