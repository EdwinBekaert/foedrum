# Interactive refinement

Good automation starts with a sharp breakdown.
Analysis and decomposition are where a human adds the most value, so Foedrum offers them interactively ([ADR 0014](../../adr/0014-interactive-refinement-plugin.md)):

- A small **Claude Code plugin** provides `/foedrum:refine #<order>`.
  You run it in your own interactive Claude Code session, investigate the order together with Claude — across the registered repositories, read-only — and steer until the path is obvious.
- When you are satisfied, the plugin writes the result into the Brewery: the analysis as an out doc on the state branch, the sub-orders as sub-issues with dependencies, and a plan per sub-order.
  The breakdown counts as approved; Foedrum starts brewing.
- Re-running `/foedrum:refine` on an order that already has sub-orders shows the current breakdown and lets you deepen, add or cancel sub-orders (never silently delete).
- The plugin is Markdown commands and skills only — no npm packages — and talks to the Brewery through the `foedrum` CLI.

Since [ADR 0019](../../adr/0019-interactive-sessions-and-one-command-layer.md), refinement is one of several interactive steps (refine, triage, review) that run in the engineer's session, with or without the Cellar running.
