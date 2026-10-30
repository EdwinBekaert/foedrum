# 0240. order and recipe work by the Brewery issue, on both surfaces

Date: 2026-10-30 · Status: Accepted · Narrows #405 (its `order`, `recipe` and claimed-order items; #592) · Amends [0125](0125-the-foedrum-plugin-is-markdown-skills-that-run-the-terminal-with-via-plugin.md) (the plugin carries `order` and `recipe`), [0144](0144-a-claimed-target-issue-gets-a-brewery-issue-that-is-its-order.md) (`order` and `brew` of a claimed order's Brewery issue act on its claimed issue instead of being refused) and [0232](0232-foedrum-mash-routes-an-issue-to-the-innkeeper-whose-question-the-answer-chooses-the-recipe-by.md) (every recipe a person chooses labels the issue, once per recipe)

## Context
The maintainer's first live run (Brewery #12, 2026-10-29) planned an order with `mash`, then had to switch it to `nip`.
That took three surfaces of work: the issue's labels edited by hand on GitHub (`recipe:mash` off, `recipe:nip` on), `foedrum order '#12'` in a terminal, then `foedrum brew '#12'`.

Three limits made it so:

- `order` and `recipe` were marked `terminalOnly` ([ADR 0125](0125-the-foedrum-plugin-is-markdown-skills-that-run-the-terminal-with-via-plugin.md)): `order` as "an ended issue again", `recipe` as a decision on a Stuck batch.
- `recipe` took only a batch id, so a person had to find the batch first, and it never touched the issue's label, so the next order of the issue routed by the old one ([ADR 0068](0068-the-intake-in-foedrum-serve-brewery-orders-and-routing-by-label.md)).
- `order '#xyz'` of a claimed order's Brewery issue was refused with `order web#401 again` ([ADR 0144](0144-a-claimed-target-issue-gets-a-brewery-issue-that-is-its-order.md)), and `brew '#xyz'` the same way through it, so a person worked by two names for one order.

What already held: `order` of an issue that never had a batch orders its first one (`orderRefusal` finds nothing live), and `recipe <batch>` on an Ordered, Conditioning or Stuck batch records `batch.recipe_chosen` with who and from where and enters the new recipe's first step, which the status comment shows as `Recipe **nip**, chosen by ada (plugin)`.
The recipe label of [ADR 0232](0232-foedrum-mash-routes-an-issue-to-the-innkeeper-whose-question-the-answer-chooses-the-recipe-by.md) was set only for a recipe an answer chose, and once per batch.

## Decision

### `recipe <batch | issue> <recipe> <reason>`
- The first argument is an issue when it is `#<n>`, `<n>` or `<alias>#<n>`, and a batch id otherwise: a batch id always has a hyphen and never a `#`, so the two never overlap. The batch-id form works as it did.
- By issue, it acts on the issue's latest batch: a claimed order's Brewery issue names its claimed issue, as for `order` below.
  - **No batch, or the latest is on tap or cancelled:** it orders the issue (claiming a target issue again first, as `order` does) and chooses the recipe on the new Ordered batch, in one command but two decisions. When the choice is refused after the order, as when the intake routed the new batch in between, the command fails with the reason and still prints `ordered #<n> as batch <id>`, since that batch stays. The ended batch's unpushed task tree stays on its kept branch ([ADR 0084](0084-a-batch-s-commits-end-in-a-pull-request-or-on-a-kept-branch.md)); the new batch starts at the base.
  - **Ordered, Conditioning or Stuck:** the recipe command of the batch-id form, on that batch: it restarts from the new recipe's first step, on the task tree so far ([ADR 0066](0066-the-task-tree-continues-from-the-latest-succeeded-attempt.md)), so no commit is lost.
  - **Brewing:** refused with `batch <id> of #<n> is brewing; foedrum stop #<n> first, then change its recipe`. Killing a running attempt stays a person's explicit `stop` ([ADR 0205](0205-stop-makes-an-order-s-brewing-batches-stuck-at-once-and-retry-continues-them.md)), never a side effect of a recipe change.
- `mash` keeps its own command; `recipe '#n' mash-in` is any other recipe.

### The label follows a person's choice
- The recipe label effect (`recipe-label.ts`) is due for every recipe a person chose (`source: human`), by an answer as before or by either form of `recipe`, except `mash-in`: it asks which recipe, and routing the issue's next order to it would ask again.
- Its key is `[batchId, "recipe-label:<recipe>"]`, one per recipe of the batch, so a change on a batch an answer had labelled labels the issue again. The other `recipe:` labels come off as before. A label an older Foedrum applied under `recipe-label` counts as applied for the recipe its result names, so it is never due again, and never takes off a label a person put on by hand since.
- The driver applies it, under the batch's lease: `recipe` records the choice, and the label shows once `serve` or `brew` drives the batch.

### `order` and `brew` by a claimed order's Brewery issue
- `order '#xyz'`, where `#xyz` is the Brewery issue of a claimed target issue (`claimOfOrder`), orders that target issue again, as `order web#401` would; `brew '#xyz'` brews its claimed batch, as `mash` already did ([ADR 0232](0232-foedrum-mash-routes-an-issue-to-the-innkeeper-whose-question-the-answer-chooses-the-recipe-by.md)).
- `orderRefusal` keeps its message for a caller that reaches it with the Brewery issue; `pause`, `stop` and `rank` keep refusing `#xyz` with the target to name.

### Both surfaces
- `order` is the first order of an issue, or an ended issue's next; its summary says so, and neither it nor `recipe` is `terminalOnly`.
- `/foedrum:order` and `/foedrum:recipe` run `foedrum order … --via plugin` and `foedrum recipe … --via plugin`, started only by the engineer (`disable-model-invocation: true`), so each is as much a person's decision as the same line in a terminal; the parity test holds them as it holds the rest.
- `retry`, `skip`, `rewind` and `cancel` stay terminal-only, a decision among the options `/foedrum:stuck` lists; `takeover`, `doctor` and `replay` keep their reasons.

## Consequences
- The live run's switch is one command in a session: `/foedrum:recipe '#12' nip "the plan's one sub-order"`, then `/foedrum:brew '#12'`.
- A person never edits a `recipe:` label by hand to change an order's recipe, though one still may: a label changed on GitHub routes the issue's next Ordered batch as before.
- `foedrum mash`'s refusal of an issue that already brews a recipe can name `foedrum recipe #<n>`.
- A Brewing batch needs two commands (`stop`, then `recipe`); folding them into one is left until someone needs it.
- A batch that goes nip → stout → nip labels `recipe:nip` once: the third choice finds its key applied. The label is then `recipe:stout`, which the next order routes by; `recipe` by issue on that ended batch labels it again under the new batch.

## Alternatives considered
- **Set the label from the command itself, through gh:** shows at once, but is an external side effect outside the ledger (invariant I4), and the command would need gh's login on every surface.
- **Restart a Brewing batch inside `recipe`, by a stop first:** one command, but kills a running attempt as a side effect of a recipe change, and records a stop the person never typed.
- **Restart from the base, the old commits on a kept branch:** a clean start, but needs a task tree that resets on a live batch and a cleanup rule for branches of a batch that has not ended; the task tree already carries the commits, and a person who wants a clean start can cancel and order again.
- **Keep the label once per batch:** smaller, but a change on a batch an answer labelled would leave the issue routing its next order by the old recipe.
