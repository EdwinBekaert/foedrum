# 0437. A Taster can report a house-yeast rule as wrong, and a writer's rules are not cut for a budget

Date: 2026-11-26 · Status: Accepted · Amends [0015](0015-house-yeast.md) and [0018](0018-house-yeast-layers.md) (a step that writes the change selects its rules within no token budget), [0122](0122-house-yeast-for-foedrum-s-own-reviews-candidates-in-the-main-checkout-rules-per-lens.md) and [0169](0169-house-yeast-rules-reach-a-batch-s-brewers-by-scope-and-lens.md) (a rule is the yardstick of a review, and a reviewer may report the rule itself as wrong) and [0268](0268-the-brewers-that-write-a-change-get-the-house-yeast-rules-of-every-lens.md) (a step that writes the change gets every rule that matches it, with no token budget)

## Context
A rule is proposed from earlier reviews and merged with the pull request it came from, and from then on every brewer and every review whose scope matches follows it or holds the change to it.
Nothing treats a rule as possibly wrong: a reviewer only names the rule a finding breaks, and the recurrence report ([ADR 0315](0315-a-rule-reviews-keep-recording-after-it-was-proposed-is-a-candidate-for-a-promotion-review.md)) catches a rule that is too weak, not a wrong one, because a wrong rule makes the reviews stop finding its mistake.
A rule that was right can also go stale: about 8 of the 58 rules in Foedrum's `.foedrum/house-yeast/` describe how the code works today, and a change that deliberately alters that design touches the files in the rule's scope.

A writer's rules were cut by date. On the 13 files of #1168, `selectRules` gave a writer step 28 rules and cut 19 of the 47 that matched, among them `script-option-through-a-tested-function`, ranked by scope and then date; the design-conformance Taster got every one that matched its lens. Foedrum's own sessions get every rule with no budget ([ADR 0271](0271-foedrum-s-own-sessions-load-the-house-yeast-rules-as-generated-path-scoped-rule-files.md)).

## Decision
- The default Taster's prompt says a rule was learned from earlier reviews and can be wrong or out of date. When following a rule would make the change worse, or the change deliberately alters what a rule describes, the Taster reports the rule itself as a finding, with its id in the `why` after the first sentence, instead of holding the change to it. The Taster's version goes from 13 to 14.
- Such a finding is text in the `why`, as any finding is: `TastingFinding` has no field for a rule, and the engine reads none. It reaches a person through the pull request, where the finding is listed. The repository's rules are read at the commit the batch starts at ([ADR 0169](0169-house-yeast-rules-reach-a-batch-s-brewers-by-scope-and-lens.md)), so the batch's own commits never steer its brewers: a rule file the Cellarman changed in the batch would not reach the batch's other steps either, and the Cellarman answers such a finding as it does any other, with a disposition.
- Only the reviewers get this permission. The Gauger and the Cellarman keep to "follow the house rules": a writer that declines a rule would hide a wrong rule from the review, which is the one that reports it.
- A step with no lens, which writes the change, gets every active rule whose scope matches the change, whatever lens it names, with no token budget. A step with a lens or lenses keeps the 2,000 tokens of [ADR 0122](0122-house-yeast-for-foedrum-s-own-reviews-candidates-in-the-main-checkout-rules-per-lens.md), per lens, and so does `/brew-review` through `node scripts/house-yeast.ts select`: a reviewer reads its rules as a yardstick for one lens, and ranking decides which of them it sees.
- `/brew-review`'s own half (its reviewer prompt, its handling of such a finding and the wording of a lesson) is in pull request #1199, not here.

## Consequences
- A Taster's finding against a rule is a finding a person settles by narrowing the rule's text or scope, or retiring it, then `npm run house-yeast:rules`; the batch does not.
- A writer's prompt grows with the rules that match: on #1168's files it holds all 47 that matched, not the 28 it was given before. I did not measure the tokens.
- The rule that ranks last, a rule that names only a lens, is no longer the one a writer loses first.
- A Brewery or repository with a very large rule set gives its writers a large prompt: the rule set is curated by its owners ([ADR 0015](0015-house-yeast.md)), and a rule that costs more than it saves is retired.
- An existing Brewery has nothing to change for the writers: its Gauger and Cellarman get every matching rule with no budget as soon as it runs this version, and a Brewery that finds the prompts too large retires or narrows rules. A Brewery that keeps its own `brewers/taster.md` does not get the new instruction: it adds the instruction to its prompt by hand, or does without it.
- The maintainer tries the changed default prompt on the next real brew after the merge.

## Alternatives considered
- **A `rule` field on `TastingFinding`:** the engine would read it, but nothing would act on it before a person does; a field the engine does not use is more code to keep.
- **The Cellarman changes the rule in the batch:** its change would not reach the batch's own brewers and would put a rule edit in a pull request about something else.
- **A larger budget for writers:** a number picked to fit one change; Foedrum's own sessions already show no budget works.
