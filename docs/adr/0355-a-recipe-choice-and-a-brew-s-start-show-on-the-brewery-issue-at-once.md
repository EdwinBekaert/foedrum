# 0355. A recipe choice and a brew's start show on the Brewery issue at once

Date: 2026-11-08 · Status: Accepted · Amends [0240](0240-order-and-recipe-work-by-the-brewery-issue-on-both-surfaces.md) (`foedrum recipe` applies the batch's due effects before it returns), [0072](0072-the-status-comment-edits-as-revisions-in-the-ledger.md) (a person's recipe line gives their reason) and [0033](0033-chaos-tests-effects-found-by-key-and-leases-at-start.md) (a tick passes over the effects before its drive as well as after)

## Context
`foedrum recipe` recorded `batch.recipe_chosen`, with the reason it requires, and applied nothing on GitHub: the recipe label, the lane label and the status comment waited for the next driver's tick.
A tick drove first and applied the effects after (`tick`, `src/engine/driver.ts`).
The drive does not wait for a session, but it awaits each attempt's worktree, and an end that comes at once (a survey with no session, a check) schedules and starts the next step in the same drive.
On the self-brew of #947 the Brewery issue said `foedrum:ordered`, with no recipe, from the choice until the brew's first drive had made three worktrees, ended the survey and its check and started the Gauger: about 90 seconds, read from the steps' deadlines in the batch's events and the issue's label times.
The status comment named who chose a recipe and from where, but not their reason; only `foedrum replay` showed it.

## Decision
- **`foedrum recipe` applies the batch's due effects before it returns.** Once its choice is recorded and the store closed, it opens a driver of its own on serve's wiring, under the owner `recipe-<pid>`, which takes that batch alone, applies its effects and no tick, so it drives nothing and starts no attempt, and lets the batch go (`runApplyEffects`, `src/cli/apply-effects.ts`).
  When another driver holds the batch, it applies nothing and says that driver's next tick does; when GitHub cannot be reached or an effect fails, it says so, and the next `foedrum brew` or `foedrum serve` applies them. The choice stays recorded either way, and the command still succeeds.
- **A person's recipe line gives their reason**: `Recipe **nip**, chosen by <who> (<where>): <reason>`, the reason made plain as every text a person or a brewer wrote (`recipeText`, `src/engine/status-comment.ts`).
  An answer to the Innkeeper records its own reason (`the answer at innkeep: mash, as suggested`), which the line now shows too.
- **A tick passes over the effects before its drive as well as after it.** What a person's command or the supervisor changed since the last tick, a lane, a recipe, goes out before the drive makes a worktree or starts a session.
  A batch whose effects failed in the first pass waits for the next tick rather than being tried again in the second, so a GitHub that is down is asked once a tick as before, and only the second pass says a batch recovered.

## Consequences
- `foedrum recipe <n> nip "<reason>"` leaves `recipe:nip` on the Brewery issue and a status comment that gives the reason before any brew runs, when GitHub can be reached and no other driver holds the batch.
- `foedrum recipe` now needs serve's setup, gh's login and the state branch, as `foedrum brew` does; without them it records the choice and says the effects wait.
- A brew's first tick shows `foedrum:brewing` and the recipe label before its first step starts.
- Steps that end at once and the step they lead to still start in one drive, so the status comment shows the step that started only at the pass after the drive. Applying effects before each start inside the drive would show it, but would interleave the drive's and the effect pass's work, which run one after another (ADR 0033); it is left out.
- `foedrum status` and the plan comment show no recipe choice, so they gain no reason; `foedrum replay` already shows it.
- **Migration**: nothing in a Brewery's files changes. The status comment of an open batch with a person's recipe choice is revised once with the reason, at its next pass, since its text changed; an ended batch's comment, which shows its end, is not written again ([ADR 0345](0345-a-pull-request-past-a-skip-says-so-and-an-ended-batch-s-status-comment-is-left-alone.md)).

## Alternatives considered
- **Leave the effects to the next tick of any driver**: a Brewery with no Cellar running shows nothing until a person brews, which is what the issue reported.
- **Have `foedrum recipe` call a whole tick**: a tick drives, and would start the batch's first attempt in a command meant to record a choice.
- **Apply effects before each attempt starts, inside the drive**: see the consequence above.
