# 0268. The brewers that write a change get the house-yeast rules of every lens

Date: 2026-10-30 · Status: Accepted · Amends [0169](0169-house-yeast-rules-reach-a-batch-s-brewers-by-scope-and-lens.md) (a brewer whose step has no lens gets the rules of every lens, within one budget, and the default Gauger and Cellarman ask for house yeast)

## Context
House-yeast rules reached only the reviewer: the default Taster was the only default brewer with `"houseYeast": true` ([ADR 0169](0169-house-yeast-rules-reach-a-batch-s-brewers-by-scope-and-lens.md)).
The Gauger and the Cellarman, who write the tests and the code, never saw them, so a defect a rule describes was written, flagged and fixed again.
Foedrum's own reviews show it: after its rule landed on main, `adr-amends-every-record-whose-rule-it-changes` was recorded again in 32 of 45 reviews, `near-miss-for-every-rule-of-a-text-form` in 16 of 22, `guard-on-two-paths-tested-on-each` in 10 of 13 and `design-page-checks-each-fact-against-its-owner` in 9 of 11 (#671).

A writer's step has no lens, and ADR 0169 gives such a step only the rules that name none.
Of the 25 rules in Foedrum's `.foedrum/house-yeast/`, 15 name a lens: 10 `test-design`, 2 `security`, 2 `design-conformance` and 1 `correctness`.
All four rules above name `test-design` or `design-conformance`, lenses Nip's Tasters do not run.

Measured with `pickRules` on those 25 rules and the commits of Brewery batch 12-2 (Foedrum's pull request #674), the change so far being what each attempt would be given:

| Attempt | Files changed so far | No lens (ADR 0169) | Nip's lenses | Every lens |
| --- | --- | --- | --- | --- |
| Gauger, first | none | 0 | 0 | 0 |
| Cellarman, first | the Gauger's 4: `schemas/event.json`, `src/schemas/events.ts`, two `touches-limit` tests | 4 | 5 | 16, about 1,100 tokens |
| Gauger's second round, Cellarman's retry | those and `src/engine/`, an ADR, a design page: 8 | 8 | 9 | 22, about 1,600 tokens |

No rule was cut under the 2,000-token budget in any of them.

## Decision
- A brewer with `"houseYeast": true` whose step has no lens gets the rules of every lens: their `scope.lens` is not read, and their files and language are matched as before. It writes the change, so it follows the rules wherever its change meets them, whichever review would judge them.
- Those rules share one budget, the 2,000 tokens of [ADR 0122](0122-house-yeast-for-foedrum-s-own-reviews-candidates-in-the-main-checkout-rules-per-lens.md), ranked as ADR 0122 ranks them. They do not get one budget per lens, as a step of several lenses does ([ADR 0220](0220-a-taster-s-step-can-run-several-lenses-together.md)).
- The files stay the change so far, from the commit the batch's change starts at to the attempt's worktree's start (ADR 0169).
- The default Gauger and Cellarman ask for house yeast. Each prompt says to follow the rules in `{houseYeast}` where its tests or change meets them, not to look for what breaks them, which is the Taster's work.
- A Taster's selection does not change: the rules of its step's lenses and those that name none.

## Consequences
- The Cellarman's first attempt gets the rules for the files the Gauger committed, and every later round gets those for the whole change so far.
- The Gauger's first attempt has changed nothing, so it gets only rules that name neither files nor a language, and Foedrum's own set has none. It misses the 10 `test-design` rules most, the rules about the tests it writes. A plan's `touches` (#590) could give it the files it is about to change; until then, this gap remains.
- Nip's own Tasters still never get the `test-design` or `design-conformance` rules, because Nip does not run those lenses. That is a separate gap, left as it is.
- A Brewery's own brewer with `"houseYeast": true` and no lens gets the rules of every lens too, where it got only those naming none.
- Each attempt of the Gauger and the Cellarman makes the two or three git calls in the clone that ADR 0169 describes, and its prompt grows by the rules it gets: about 1,100 to 1,600 tokens on Foedrum's own set.
- The maintainer tries the changed default prompts on the next real brew after the merge.

## Alternatives considered
- **The lenses of the recipe's Tasters:** the rules of the lenses that will judge the change. On Foedrum's set it adds one rule (`unread-file-claims-nothing`), and none of the four that #671 cites.
- **One budget per lens, as a step of several lenses has:** a writer has no lens of its own to rank by, and five budgets would allow up to 10,000 tokens per attempt.
- **The files the order names:** reading paths out of issue text is guessing.
- **The plan's `touches`:** only after #590.
