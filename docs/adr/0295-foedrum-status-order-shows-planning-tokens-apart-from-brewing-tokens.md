# 0295. foedrum status <order> shows planning tokens apart from brewing tokens

Date: 2026-10-31 · Status: Accepted · Amends [0159](0159-foedrum-brewers-reports-each-brewer-s-attempts-outcomes-stuck-batches-and-tokens.md) (what counts as planning and brewing, and `status` taking an order) and [0188](0188-foedrum-status-watch-redraws-a-board-of-the-live-batches.md) (`--watch` is refused with an order)

## Context
A mashed order spends tokens before any code is written: the Innkeeper's `mash-in` ([ADR 0232](0232-foedrum-mash-routes-an-issue-to-the-innkeeper-whose-question-the-answer-chooses-the-recipe-by.md)), the Brewmaster's `plan` and its lens steps, and a person's `lauter` session ([ADR 0286](0286-foedrum-lauter-corrects-a-plan-at-gate-1-in-an-interactive-session.md)).
Since [ADR 0285](0285-an-approved-plan-becomes-brewery-sub-issues-through-the-ledger.md) an approved plan becomes sub-orders, each brewed by a batch of its own.
`foedrum status` sums each batch's attempts ([ADR 0172](0172-an-attempt-s-receipt-from-its-stream.md)) and `foedrum brewers` each brewer's tokens (ADR 0159), but nothing says what an order's planning took against what its brewing took (#392).

## Decision
- **`foedrum status [<order>]`.** With an order, given as `order` takes it (`<alias>#<n>`, `#<n>` or `<n>`), `status` lists that order's batches and its sub-orders', in the order they were ordered, as the board's rows, then two lines: `planning:` and `brewing:`, each the total and the four counts `foedrum brewers` prints, or `none reported`. Without an order it prints the board as before. A Brewery issue with no batch of its own that is the order of a claimed issue ([ADR 0144](0144-a-claimed-target-issue-gets-a-brewery-issue-that-is-its-order.md)) names that claimed issue's batches whose order it is, not those an earlier or a later Brewery issue orders. An issue no batch brews is refused with one line and exit code 1, as `replay` refuses a batch it does not know; `--watch` with an order is refused too, since the board shows every batch.
- **Planning is by the recipe an attempt was scheduled under.** An attempt scheduled under `mash` or `mash-in`, the recipes a sub-order may not name (`PLANNING_RECIPES`, ADR 0285), is planning; every other attempt is brewing. The recipe is the one the attempt recorded when it was scheduled, else its batch's (`attemptRecipeOf`, ADR 0260), so a batch the Innkeeper routes on to `nip` counts its `mash-in` attempts as planning and its `nip` attempts as brewing, and a plan still under review is planning before any sub-order exists. An order brewed straight by `nip` shows brewing only.
- **The order's sub-orders are the folded state's**, its `subOrders` and each sub-order's batches, also those ordered before a sub-order recorded its plan entry. Sub-orders never plan again (ADR 0285), so one level holds them all.
- **Tokens, never a cost** ([ADR 0181](0181-receipts-show-no-cost.md)): the sum of each finished attempt's `usage`; an attempt that reported none adds nothing.
- **The plugin's `/foedrum:status` passes the order through** ([ADR 0125](0125-the-foedrum-plugin-is-markdown-skills-that-run-the-terminal-with-via-plugin.md)).

## Consequences
- A maintainer sees what planning an order cost against what building it cost, at no cost: no model call, no lease, no event.
- A Brewery recipe of another name that plans counts as brewing; only `mash` and `mash-in` plan.
- `status` takes one optional argument more, and the help, the command page and the plugin skill say so.

## Alternatives considered
- **Planning is a batch that wrote a plan** (a succeeded attempt whose output `planOf` reads). It misses a `mash-in` routed on to `nip`, whose question was planning, and counts every attempt of such a batch on one side.
- **Planning is the order's own batches, brewing its sub-orders'.** It counts an order brewed straight by `nip` as all planning.
- **A section of `foedrum brewers`.** Brewers are summed over every order; the split is per order.
- **A cost beside the tokens.** claude reports list prices, not what a user pays (ADR 0181).
