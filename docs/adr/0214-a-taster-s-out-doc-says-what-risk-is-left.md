# 0214. A Taster's out doc says what risk is left

Date: 2026-10-26 · Status: Accepted · Amends [0161](0161-lens-steps-run-a-taster-whose-findings-are-advisory-unless-the-step-blocks.md) (the Taster's out doc and where its report is shown)

## Context
A Taster's out doc holds its verdict and its findings (ADR 0161). It does not say what risk is left once its review is done, or what it could not verify. The merge brief (#551) is to show that judgement to the person who merges, and the maintainer settled (2026-10-25, #274) that it comes from the last Taster, with no new brewer run: the engine writes every fact from the ledger, and only this judgement is the model's.

## Decision
- **The field.** A Taster's out doc may hold `riskLeft`: a list of at most 10 items, each one line of at most 300 characters. A list past 10 items, or an item past 300 characters or of more than one line, breaks the schema, and the attempt fails with the out doc invalid, as with any other schema error. The field is optional, and an empty list and an absent one mean the same: nothing to say. An older Foedrum cannot read an out doc that has it, as ADR 0191 records for `dispositions`.
- **What goes in it.** In the lens's own terms, two kinds of item: the risk that remains after the review, and what the Taster could not verify (a file it could not read, behaviour only a run would show). An item is not a finding: a finding asks for a change at a place, even a `minor` one, while an item of `riskLeft` asks for nothing and names what no change in this review would settle. A Taster that can say what to change writes a finding, not an item, and never writes the same thing as both.
- **The instructions.** One paragraph in the default Taster's Out doc section (`defaults/brewers/taster.md`) asks for `riskLeft` in those terms, and for an empty list, or none, when there is nothing to say. The lens files stay as they are: each lens's own terms are already in its text, and the paragraph tells the Taster to use them.
- **Recording.** No new event. The list travels in the out doc on `step.finished`, as the findings do, and `tastingOf` returns it beside the verdict and findings, an empty list when the out doc has none. A parallel group's children each keep their own list, since each keeps its own out doc (ADR 0168). A Taster's attempt blocked by its findings records no list, as it records no success; a later round writes its own and gets no earlier round's list.
- **The last Taster.** The list the merge brief (#551) shows is that of the last tasting step in the recipe's order: the latest finished attempt of that lens step when it succeeded, or of each child when that step is a parallel group of lens steps, in the recipe's order. This is how the status comment reads a Taster's findings (ADR 0161): an earlier round's list is no longer current.
- **The filter.** Every item passes `withoutSecrets` on its way to the status comment and the pull request body, as the findings do (ADR 0088), so an item that looks like a secret is left out with the fixed line naming its step; in the body it is also put on one line.
- **Where it shows now.** In the status comment, a `**Risk left**` section right after `**Findings**`, the items of each Taster's step whose latest finished attempt succeeded, at most 5 per step with a count of the rest. In the pull request body's report of each step, a `risk left:` line per item after its `finding:` lines. The merge brief will add its own heading (#551).

## Consequences
- The person who merges reads, in the Taster's words, what the review did not settle, without a brewer run of its own.
- A Taster writes a few more lines; a Brewery's own Taster that writes none reads as before.
- An item cannot ask for a change: what a Taster wants changed stays a finding, and only a finding can hold a blocking step up.

## Alternatives considered
- **A new brewer run, after the last tasting, to judge the risk left:** rejected by the maintainer (2026-10-25); the last Taster has just read the change, and another run costs tokens to read it again.
- **Every Taster's list in the merge brief:** rejected. An earlier step's Taster reviewed a change that later steps may have changed; the last tasting step's lists are the current ones, and the status comment keeps every step's.
- **Risk left as a `minor` finding with a marker:** rejected. A finding names a place to change and counts in the verdict's rules; mixing the two would make a Taster's open questions look like asks, and a dispositions round would have to answer them.
- **Cut a long list or item instead of refusing it:** rejected. Every other bound of an out doc is a schema bound, and a cut item could lose the part that matters; the Taster's second attempt writes a shorter one.
- **A `riskLeft` event of its own:** rejected. The list is part of the Taster's report and ends with its step, as the findings do.
- **Words of their own in each lens file:** rejected for now. The Taster's paragraph says to use the lens's terms, and no lens needs more.
