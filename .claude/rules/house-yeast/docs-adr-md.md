---
paths:
  - "**/docs/adr/*.md"
---

<!-- Generated from .foedrum/house-yeast/ by npm run house-yeast:rules; do not edit. -->

# House yeast

Rules learned from reviews of Foedrum's own pull requests (ADR 0122), for the files this session reads or changes (ADR 0271). Follow them where your change meets them: /brew-review looks for what they describe.

## adr-amends-every-record-whose-rule-it-changes (semantic)

A new ADR status line names every older record whose table or rule it changes, not only the newest one it builds on, because the ADR index back-links only from Amends links.
