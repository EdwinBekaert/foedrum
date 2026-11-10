---
paths:
  - "**/*.md"
---

<!-- Generated from .foedrum/house-yeast/ by npm run house-yeast:rules; do not edit. -->

# House yeast

Rules learned from reviews of Foedrum's own pull requests (ADR 0122), for the files this session reads or changes (ADR 0271). Follow them where your change meets them: /brew-review looks for what they describe.

## heading-and-back-references-follow-the-body (semantic)

When a change alters what a section lists or allows (a count, a budget, the rows of a table), its heading and the lines that introduce or refer back to it say the same thing, so a reader never meets two framings of one section.
