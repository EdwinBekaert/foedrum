# 0426. A tasted entry requires its tokens per order split

Date: 2026-11-19 · Status: Accepted · Amends [0425](0425-the-flight-shows-tokens-by-kind-and-how-each-run-ended-beside-the-score.md) (the entry's `tokensPerOrderSplit` is required, not optional)

## Context
[ADR 0425](0425-the-flight-shows-tokens-by-kind-and-how-each-run-ended-beside-the-score.md) made the `tasted` entry's `tokensPerOrderSplit` optional, "because nothing needs migrating until the first publish", and said an entry written before the split stays valid.
That is the opposite of the repository's rule: before the first publish nothing old has to keep working, and a new field is required unless the design itself makes it optional (CLAUDE.md, Git and pull requests).
The design does not make it optional: `scripts/flight-report.ts` always writes the split, and `defaults/models.jsonc` holds no `tasted` entry, so no entry without it exists.

## Decision
- **`tokensPerOrderSplit` is required in a `tasted` entry.** An entry without it is refused, with a problem line naming the field. `schemas/models.json` is generated again.
- **The tests' entries carry a split**, and a test shows an entry without it is refused.

## Consequences
- No entry is valid without its split, so a later token guess (#1143) never has to handle one that lacks it.
- ADR 0425's sentence "An entry written before the split has none, and stays valid" no longer holds.

## Alternatives considered
- **Keeping the field optional:** nothing in the design needs an entry without it, and the rule is that no old data is kept working before the first publish.
