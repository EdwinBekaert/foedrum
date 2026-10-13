# 0014. Interactive refinement through a Claude Code plugin

Date: 2026-10-13 · Status: Accepted

## Context
Autonomous brewing is only as good as the breakdown it starts from. Investigating an order — where the change belongs, which repositories it touches, what the right approach is — benefits most from a human steering in real time ("go deeper here", "check that repository too", "that's enough"). Brewers never hold a live conversation ([ADR 0006](0006-no-mid-run-questions.md)), and a dashboard chat would duplicate what Claude Code already does well.

## Decision
- Foedrum ships a small **Claude Code plugin** with a `/foedrum:refine #<order>` command, used in the developer's own interactive Claude Code session.
- Refinement investigates read-only across the Brewery's registered repositories and ends by writing to the Brewery through the `foedrum` CLI: the analysis as an out doc, sub-orders as sub-issues with dependencies, and a plan per sub-order.
- A refined breakdown counts as approved; automated brewing starts from it.
- Re-running refine on a decomposed order shows the current breakdown and allows deepening, adding or cancelling sub-orders.
- The plugin contains Markdown commands and skills only; no npm dependencies.
- Delivered in M2, together with decomposition.

## Consequences
- The strongest human-in-the-loop moment is fully interactive, while everything after it stays autonomous and token-efficient.
- Users without the plugin can still rely on automated decomposition with an approval gate.
- The CLI needs commands the plugin can call to write sub-orders and out docs; they are part of Foedrum's public interface.

## Alternatives considered
- **Steering through issue comments:** works without a live session, but each round trip is a new attempt — slow and costly for exploratory work.
- **A chat in the dashboard:** rebuilds Claude Code; arrives late (M6).
- **No interactive part:** loses the step where human judgement pays off most.
