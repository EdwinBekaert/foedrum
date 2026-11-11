# 0374. `foedrum mash --override` asks the Innkeeper again for an issue with a recipe

Date: 2026-11-11 · Status: Accepted · Amends [0232](0232-foedrum-mash-routes-an-issue-to-the-innkeeper-whose-question-the-answer-chooses-the-recipe-by.md) (`foedrum mash` of a batch that has a recipe asks again with `--override`, and its refusal names the flag), [0240](0240-order-and-recipe-work-by-the-brewery-issue-on-both-surfaces.md) (the recipe label is keyed per choice, so a choice back to an earlier recipe labels the issue again) and [0336](0336-small-rough-edges-of-the-self-brew-trial.md) (a mash with `--override` of an on-tap or cancelled batch orders the issue again, where every mash of one was refused)

## Context
`foedrum mash <n>` asked the Innkeeper only while the issue's latest batch had no recipe ([ADR 0232](0232-foedrum-mash-routes-an-issue-to-the-innkeeper-whose-question-the-answer-chooses-the-recipe-by.md)).
Once it had one, the command refused: `already brews the recipe <name>; foedrum recipe <n> <recipe> <reason> brews it with another`; an issue on tap or cancelled was refused earlier, naming `foedrum order`.
A person who wanted a second opinion, or a new plan, had to pick the next recipe with `foedrum recipe`, with no suggestion (#932).

What already held:
`foedrum recipe` by issue orders an ended issue again under `orderRefusal`, restarts an Ordered, Conditioning or Stuck batch from the new recipe's first step (a Stuck one resumed), and refuses a Brewing one until `foedrum stop` ([ADR 0240](0240-order-and-recipe-work-by-the-brewery-issue-on-both-surfaces.md)).
An issue on tap whose pull request has no recorded end cannot be ordered again ([ADR 0339](0339-an-issue-has-one-live-batch-no-second-batch-while-its-pull-request-is-open.md)).
The recipe label is due once per recipe of a batch, `[batchId, "recipe-label:<name>"]`, and takes the issue's other `recipe:*` labels off; so a batch that goes nip → stout → nip keeps `recipe:stout`, which ADR 0240 named as a consequence.
A re-mash makes that path an ordinary one: the issue would name the wrong recipe and route its next order by it.
A new plan's breakdown marks the sub-orders it leaves out cancelled and keeps their batches ([ADR 0211](0211-the-intake-starts-ready-sub-orders-at-their-order-s-rank-once-their-blockers-merged.md)), so planning an order again while its sub-orders brew would leave them with no order behind them.

## Decision
- **`foedrum mash <n> --override`** asks the Innkeeper again for an issue whose latest batch has a recipe, and the answer chooses the recipe as on a first mash (ADR 0232). `--override` is a flag of `mash` beside `--take` (`MashCommand`), and `mash` without it behaves as before.
- **It follows `foedrum recipe`'s lanes**, with `mash-in` as the recipe:
  - an issue on tap or cancelled is ordered again, under `orderRefusal`, so one on tap with a pull request with no recorded end is refused with that line (ADR 0339), and the new batch is routed to `mash-in`;
  - an Ordered, Conditioning or Stuck batch is restarted on `mash-in`'s first step by the `recipe` command, a Stuck one resumed; a Stuck reason that offers no `recipe` (`order_changed`) is refused with `decide`'s line;
  - a Brewing batch is refused with `#<n> is brewing; foedrum stop <n> first, then foedrum mash <n> --override`, before the lease check, so `--override --take` on another driver's Brewing batch takes nothing over: killing a running attempt stays a person's explicit stop ([ADR 0205](0205-stop-makes-an-order-s-brewing-batches-stuck-at-once-and-retry-continues-them.md)).
- **The choice records who asked**: `batch.recipe_chosen` of `mash-in`, `source: "human"`, with the reason `the engineer ran foedrum mash --override`. `mash-in` labels nothing, as before.
- **An order whose approved plan has unfinished sub-orders is refused**, in any lane, before anything is ordered: a sub-order its latest breakdown keeps whose batch has not ended, or is on tap with a pull request with no recorded end. The line names them: `#12's approved plan opened sub-orders #30; a new plan would leave them with no order: brew them, or foedrum recipe <sub-order> <recipe> <reason> changes one`. A sub-order with no batch yet, one a later breakdown left out (marked cancelled), and one whose batch ended do not refuse it.
- **Without `--override`**, a batch that has a recipe is refused as before, and the line names the flag: `#12 already brews the recipe stout; foedrum mash 12 --override asks the Innkeeper again, or foedrum recipe 12 <recipe> <reason> brews it with another`. The line for an issue on tap or cancelled is unchanged.
- **The recipe label is keyed per choice.** The fold counts a batch's human choices by recipe (`Batch.humanChoices`), and a recipe's first choice keeps the key it always had, `recipe-label:<name>`, while its n-th is `recipe-label:<name>#<n>`. So a choice back to an earlier recipe is due again, and the issue ends with that recipe's label alone. A label an older Foedrum applied under `recipe-label` counts only for a recipe's first choice.
- **`/foedrum:mash`** passes `--override` only when the engineer typed it, as `--take`, and its refused line names the flag.

Rejected: leaving the label once per recipe (ADR 0240's consequence would become an ordinary path); keying the label on every choice's ordinal across recipes (every existing batch would get a new key and a GitHub read on upgrade); refusing every order with a sub-order not marked cancelled (an order whose sub-orders all merged could never be planned again); refusing the order's re-mash on its own open pull request with a new line (`orderRefusal` already says it).

## Consequences
- An engineer gets a second suggestion for an issue in one command, `foedrum mash <n> --override`, and the answer brews the chosen recipe from its first step, on the task tree so far (ADR 0066).
- A re-mash ends with one recipe label on the issue, the chosen recipe's, also when it goes back to one chosen before in the batch.
- **Upgrade**: the state is folded from every event at each start, so the counts hold for existing batches. A batch whose current recipe was chosen once keeps its applied key and nothing is due. Only a live, latest batch whose current recipe was chosen twice or more (nip → stout → nip) gets a new key; the driver reads the issue's labels, records it when the label already shows alone, and otherwise puts the right label on and takes the stale one off.
- `foedrum recipe` has the same gap for sub-orders: it orders an order again while its sub-orders brew. It is left to a follow-up.
- **Migration**: none. `--override` is a new flag; without it `foedrum mash` behaves as before but for its refusal line, which names the flag. No file of a Brewery changes.
