# 0204. A dismissal names the evidence that shows it

Date: 2026-10-26 · Status: Accepted · Amends [0191](0191-the-step-a-findings-route-goes-back-to-records-a-disposition-for-each-finding.md) (what a `dismissed` and a `pre-existing` `why` holds, and when a later round contests one)

## Context
A brewer that a findings route brought back records a disposition for each finding (ADR 0191). A `dismissed` one has a `why` that says why it is not a defect, and a `pre-existing` one a `why` that says it was there before the change. A later round reads them and may contest a dismissal once. Nothing asks a `why` to point at anything, so the later round can only weigh one claim against another, and a confident sentence passes as well as a checked one (#521).

The Elephant-Goldfish Model's resolve step ([google/elephant-goldfish-model](https://github.com/google/elephant-goldfish-model)) has a rejected finding contested with evidence, not with an opinion.

## Decision
- **A `dismissed` or `pre-existing` `why` names its evidence:** a file and line that shows it, a test, or the sentence of the order or of a decision record it relies on. The Cellarman's prompt asks for it, and its example shows one.
- **A later round checks that evidence before it lets the disposition stand.** The lenses' fixed text says: a dismissal or pre-existing finding whose `why` names no evidence, or whose evidence does not show what it claims, is raised once, as ADR 0191's contest, a new finding that names the old one and says why.
- **`fixed` is unchanged:** its `why` stays optional; the later round sees the fix in its change.
- **No schema change.** A `why` stays one or two sentences, at most 2,000 characters; the engine does not read whether it names evidence, the next round does.

## Consequences
- A dismissal the later round accepts rests on something it read, not on the brewer's word.
- A dismissal without evidence costs one contest, as a wrong one does under ADR 0191; the rounds stay bounded by the route's `maxRounds`.
- The Cellarman writes a few more words per dismissal.

## Alternatives considered
- **A field of its own for the evidence (`evidence: { file, line }`):** rejected. Evidence can be a test or a sentence of the order as well as a place, and the later round is a model that reads a sentence; a field would add a schema change and an older Foedrum that cannot read it, for nothing the engine decides on.
- **Evidence for `fixed` too:** rejected. The fix is in the change the later round reviews (ADR 0190).
