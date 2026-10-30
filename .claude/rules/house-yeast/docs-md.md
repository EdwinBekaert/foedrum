---
paths:
  - "**/docs/**/*.md"
---

<!-- Generated from .foedrum/house-yeast/ by npm run house-yeast:rules; do not edit. -->

# House yeast

Rules learned from reviews of Foedrum's own pull requests (ADR 0122), for the files this session reads or changes (ADR 0271). Follow them where your change meets them: /brew-review looks for what they describe.

## design-page-leaves-a-lens-rule-to-the-lens (semantic)

A design page or ADR that names a lens or brewer prompt says what it is for and links it, and leaves the prompt's own rules (severities, what it reports) to the prompt file, or states them exactly as the prompt does.
