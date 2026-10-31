# 0290. A sub-order's brewers read its plan entry from the parent's recorded plan

Date: 2026-10-31 · Status: Accepted · Amends [0285](0285-an-approved-plan-becomes-brewery-sub-issues-through-the-ledger.md) (the plan entry a sub-order's batch records is an input of its Gauger and its Taster), [0197](0197-acceptance-ships-as-a-default-diff-lens-and-nip-tastes-through-it-beside-correctness.md) and [0276](0276-the-order-a-review-reads-holds-its-recorded-scope-decisions.md) (the acceptance lens reads a sub-order's plan entry as a scope record beside the order)

## Context
Since ADR 0285 a sub-order's batch records the plan entry it was ordered from (`Batch.plan`: the parent batch, its approved plan step and attempt, and the entry's id), but no brewer reads it.
The Gauger writes the sub-order's tests from the order alone, and the Taster's acceptance lens (ADR 0197) judges the change against the order alone, although the approved entry says what the sub-order builds, when it is done, what it touches and why its recipe.
Building from the reviewed plan, not from the sub-issue's text alone, is what #389 asked for (its 2026-10-26 comment).
The parent's worktrees are cleaned once it is on tap, and the sub-issue's body holds only part of the entry.

## Decision
- **A brewer input source `plan-entry`**: `{ "name": "planEntry", "from": "plan-entry" }`, the entry of the approved plan this batch was ordered from.
- **It is read from the parent batch in the state**: the attempt `Batch.plan` names, its succeeded `step.finished` output read as a plan (`planOf`), and the entry with `Batch.plan.entry`'s id; never from a worktree, a file or the state branch.
  That output is what the approval's digest signed (ADR 0281).
  A parent, attempt or entry the state does not hold fails the attempt's planning with that reason, as an input whose step has no out doc does.
- **Its text** is the entry as the plan comment shows a sub-order (ADR 0233): its id and title, where it builds and by what mechanism, its size, done when, recipe and why, test-first off, not ready, the paths it touches, what it depends on, and then the plan's alternatives; every text the planning brewer wrote escaped and checked for secrets as the comment does it, and passed in nonce tags as data like every input (ADR 0041).
- **A batch with no `plan`** (every order that is not a sub-order) leaves the input out, as a skipped step's input is (ADR 0064), so its prompt reads as before.
- **The Gauger and the Taster read it.** The Gauger's prompt makes the entry's done-when and touches part of what its tests pin, the order deciding where they differ.
  The Taster reviews through every diff lens, so every lens of a sub-order's tasting gets the entry; only the acceptance lens says what to do with it: its done-when is a scope record like the maintainers' comments on the order (ADR 0276), each of its items judged built, built in part or missing.
  An input per lens would need a lens-level input mechanism, which does not exist.

## Consequences
- A sub-order is built and tasted against the plan a person signed off at gate 1.
- The entry's text follows the plan comment's per-sub-order section, so a change to that section changes what the brewers read.
- Another brewer reads the entry by naming the input; no engine change is needed.
