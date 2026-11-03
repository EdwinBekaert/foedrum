# 0315. A rule reviews keep recording after it was proposed is a candidate for a promotion review

Date: 2026-11-03 · Status: Accepted · Amends [0122](0122-house-yeast-for-foedrum-s-own-reviews-candidates-in-the-main-checkout-rules-per-lens.md) (a second signal for a promotion candidate, of any kind of rule) and [0018](0018-house-yeast-layers.md) (what a rule that does not stop its defect leads to)

## Context
[ADR 0122](0122-house-yeast-for-foedrum-s-own-reviews-candidates-in-the-main-checkout-rules-per-lens.md) makes a rule a promotion candidate by its kind alone: a `structural` rule can become a check ([ADR 0299](0299-a-structural-rule-becomes-a-biome-gritql-plugin-whose-message-names-the-fix.md)), and a `semantic` rule stays a prompt.
Nothing says when a rule, of either kind, does not stop the defect it was written for.

The candidates store holds the answer: a lesson that reviews keep recording after its rule was proposed is a defect the rule did not prevent.
On 2026-11-03, `adr-amends-every-record-whose-rule-it-changes` was recorded again in 43 of the 167 reviews after it was proposed, `each-guard-condition-has-its-own-case` in 32 of 113, and five more rules in 10 or more; six of those seven are `semantic`.
Since 2026-10-30, when Foedrum's own sessions started loading the rules ([ADR 0271](0271-foedrum-s-own-sessions-load-the-house-yeast-rules-as-generated-path-scoped-rule-files.md)), the top three were still recorded in 24, 11 and 10 of 50 reviews.
Issue #685 asked for a report that names them as candidates for a check.

## Decision
- **Recurrence after a rule was proposed is a second signal for a promotion review, for a rule of any kind.** `node scripts/house-yeast.ts recurring` counts, per active rule, the distinct reviews that recorded its lesson strictly after its `created` day (the day the rule was proposed, ADR 0122; a review that day may be the one that proposed it), of all the reviews recorded after that day, and lists a rule recorded in at least `minReviews` of them (10, set from the counts above; `--min` overrides it for one run) as a candidate for a check.
- **A second column counts from `--since`** (default 2026-10-30, ADR 0271), so a later reading shows whether loading the rules in sessions stopped the defect.
- **A rule no candidate ever named is listed apart**, so a renamed lesson never reads as a rule that works.
- **The report changes nothing by itself.** It reads the rule files and the candidates store and writes nothing, and no check fails on it. A person acts on a listed rule with one issue per rule.
- **The review may end in a sharper prompt rather than a check.** A structural rule becomes a check as ADR 0299 says; a semantic rule may become a check for a structural part of it, or be reworded, narrowed or split, and stays a prompt otherwise. ADR 0018's "a human always approves a rule" holds for every outcome.

## Consequences
- Six of today's seven candidates are semantic: each gets an issue, and the person reading it decides between a check and a sharper rule.
- The count reads `created`, the day a rule was proposed, not the day its pull request merged, so reviews in between count against the rule; a rule proposed long before it merges reads worse than it is.
- `minReviews` is one constant in `scripts/house-yeast/core.ts`; a later reading that finds it too high or too low changes it there.

## Alternatives considered
- **Only structural rules, as ADR 0122 has it:** six of the seven rules reviews keep recording would never come up, though they are the defects that recur most.
- **A heading that says only "due for curation":** it hides the question #685 asks, whether a check could catch what the prompt does not.
- **Counting from the merge of the rule's pull request:** the store does not record it, and the rule file's git history would make the report read git for a difference of a few days.
