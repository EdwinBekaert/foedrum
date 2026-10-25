# 0191. The step a findings route goes back to records a disposition for each finding

Date: 2026-10-25 · Status: Accepted · Amends [0005](0005-typed-step-outcomes-and-out-docs.md) (an out doc's fields on a findings route), [0128](0128-an-attempt-a-route-schedules-gets-what-sent-it-back.md) (what a later round is given from the route) and [0161](0161-lens-steps-run-a-taster-whose-findings-are-advisory-unless-the-step-blocks.md) (a later tasting round's inputs and rules)

## Context
When a blocking lens step's Taster ends with `changes`, its out doc is the route input of the step the route goes back to (ADR 0128), and that brewer, the Cellarman in a test-first recipe, works on it. Nothing records what it did with each finding. The next tasting round starts fresh, sees none of it, and can raise a finding that was already answered, round after round until the route's `maxRounds` runs out (#261). A pre-existing defect is never fixed in the round but filed as an issue of its own (ADR 0094); the engine's loop has no way to say so.

The maintainer chose (2026-10-25) three dispositions, and that a later round may contest a dismissal once, with a reason, rather than never.

## Decision
- **`dispositions` in the out doc.** A brewer that a findings route brought back may list, for each finding of its route input: the finding's file and line as the Taster wrote them (or the change as a whole), and one of
  - `fixed`;
  - `dismissed`, with a `why`: not a defect;
  - `pre-existing`, with a `why`: there before the change and not made worse, so never fixed in the round (ADR 0094).
  The field is optional, so every current out doc still reads, and bounded in count and length as a Taster's findings are. The Cellarman's prompt says to write it when its input holds a Taster's findings.
- **A later round gets the earlier findings with their dispositions**, as one more input, in the order the rounds ran. A finding with no disposition is listed as open.
- **The lenses' fixed text** says: never raise a fixed, dismissed or pre-existing finding again as it was. A fix that did not fix it, or a dismissal the Taster holds wrong, is raised once as a new finding that names the old one and says why. A round cannot pass by dismissing everything, and a finding is not repeated without a reason.
- **The pull request lists the pre-existing findings as to file**, with their place and why, in the brewed layout's report of the step (ADR 0167), so the reviewer files them.
- **Schemas.** `dispositions` goes into the out doc schema and the event that records the outcome (`npm run schemas`). An older Foedrum cannot read an out doc or event that has it, as ADR 0181 records for receipts.

## Consequences
- A second round knows what the first round's findings came to and does not ask for the same thing again.
- The Cellarman writes a little more on a findings route; no other brewer changes.
- A contested dismissal costs at most one more finding per dismissal; a disagreement that outlasts the rounds ends Stuck with it open (ADR 0192).

## Alternatives considered
- **Two dispositions, `fixed` and `dismissed`:** rejected by the maintainer; a pre-existing defect would be dismissed in words, and nothing would list it for filing.
- **Never raise a dismissed finding again:** rejected by the maintainer; a wrong dismissal would go through unseen.
- **The Taster works out the dispositions from the diff:** rejected. Only the brewer that made the fix knows why it left a finding as it was.
