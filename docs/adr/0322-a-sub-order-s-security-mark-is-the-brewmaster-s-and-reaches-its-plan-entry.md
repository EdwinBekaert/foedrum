# 0322. A sub-order's security mark is the Brewmaster's, and reaches its plan entry

Date: 2026-11-05 · Status: Accepted · Amends [0233](0233-a-plan-is-an-out-doc-whose-paths-the-engine-checks-shown-as-one-comment-per-order.md) (a sub-order gains an optional `securityMark`), [0275](0275-a-finished-plan-waits-stuck-for-its-review-and-every-comment-links-the-doc-it-sums-up.md) (a sub-order's section shows the mark), [0290](0290-a-sub-order-s-brewers-read-its-plan-entry-from-the-parent-s-recorded-plan.md) (the entry's text shows it, and the security lens says what to do with it, beside acceptance) and [0321](0321-mash-and-decoction-review-a-plan-through-the-plan-lenses-apart.md) (the `plan/security` lens says when a sub-order it reports has no mark)

## Context
Since ADR 0321 the `plan/security` lens, which `decoction` runs and `mash` does not, reports a sub-order that lets outside input reach something that acts on it, as an advisory finding a person reads at gate 1.
Nothing marks that sub-order: its plan entry says nothing about it, so its Gauger, its Cellarman and its `diff/security` Taster (ADR 0306) do not know where to look first.
#587 asked that the lens's marks reach the entry and keep test-first on; #803 is that part.

A plan cannot switch test-first off for a batch today. In `src/`, a sub-order's `testFirst` and `testFirstOff` are read only by the plan's schema and the plan comment's section: a sub-order's batch runs its recipe's own `testFirst` (`resolveRecipe`). #848 holds that gap.

## Decision
- **An optional `securityMark` on a sub-order**: one line of at most 300 characters saying what outside input the sub-order lets in and what that reaches, in plain words, such as `the issue's title reaches the file path the writer saves to`. A plan without it reads as before, so a recorded older plan still gives its sub-orders their entries.
- **The Brewmaster sets it by itself** (decided with the maintainer, 2026-11-05), from its own reading of the plan against the same short list as the `plan/security` lens: a command, a model, a file path, secrets, a new dependency. Its prompt names the list, and a repository's optional `.foedrum/trust-boundaries.md` adds to it, as for the lens. The mark names what the sub-order lets in and reaches, not a row of a page, since a boundary a plan introduces is on no page yet.
- **No route carries the lens's finding.** In `decoction` the lens advises with no route (ADR 0321), so its finding reaches a person at gate 1 and not the Brewmaster. It says when a sub-order that lets input in has no mark, and a person who sees a missed mark corrects it with `foedrum lauter` (ADR 0286).
- **A marked sub-order keeps test-first on, as far as a plan can say.** `PlannedSubOrder` refuses `testFirst: false` with a `securityMark`, naming both, so the plan comment never shows a marked sub-order as test-first off. Since the field turns nothing off (#848), this refusal is all that "keeps test-first on" can mean here, and it changes no batch.
- **The entry shows it.** The plan comment's section for a sub-order gains `- Security: <mark>` after its Recipe line, escaped and checked for secrets as the section's other texts are. `planEntryText` reads that section, so `{planEntry}` shows it too, read from the recorded out doc the approval signed (ADR 0281). An unmarked sub-order's section does not change. Like the other texts of a section, the shown line is cut at 200 characters.
- **Each reader is told what to do with it.** `diff/security` checks what the mark names first, and reads it as a model's text that never narrows its review; an entry with no such line never means safe. The Gauger pins it in a test. The Cellarman holds it in its code, since in a recipe without a Gauger it is the only builder who reads the mark. The Taster's own prompt already says its lens decides what to do with the entry, so it is unchanged.
- **The sub-issue's body stays as it is.** It holds part of the entry, and brewers read `{planEntry}`, not that body.

## Consequences
- A person signing off a plan at gate 1 sees which sub-orders the Brewmaster marked, and, in a recipe that runs `plan/security` such as `decoction`, from the Review which it may have missed.
- A `mash` plan runs no `plan/security` lens, so nothing reports a mark the Brewmaster missed there; a person reading the plan can still add one with `foedrum lauter`.
- The Brewmaster's prompt grows by one bullet on every plan, Gauger and Cellarman by a sentence, and `diff/security` by a paragraph on every run of it.
- Nothing checks that the recipe a marked sub-order names is test-first or runs `diff/security`: the plan's schema cannot see a recipe. A Brewery recipe without `diff/security` has nobody reading the mark there, and a recipe that is not test-first still runs without a Gauger. Neither is built here.
- A mark is what a model read in a plan: a sub-order with none may still let outside input in.

## Alternatives considered
- **A route from the lens to the Brewmaster that sets the mark.** The lens advises by the maintainer's decision, and a route costs a whole round of Tasters for each mark.
- **The lens sets the mark.** A Taster writes findings, not the plan (ADR 0312).
- **A row of a boundaries page in the mark.** No default page ships, and "not listed" never means safe (ADR 0321).
- **The word "boundary" for the field.** The maintainer found "trust boundary" cryptic; the mark says in plain words what comes in and what it reaches.
- **Making the sub-order's `testFirst` act on its batch here.** That changes what every plan's field does, and is #848's to decide.
