---
paths:
  - "**/CLAUDE.md"
  - "**/src/**"
---

<!-- Generated from .foedrum/house-yeast/ by npm run house-yeast:rules; do not edit. -->

# House yeast

Rules learned from reviews of Foedrum's own pull requests (ADR 0122), for the files this session reads or changes (ADR 0271). Follow them where your change meets them: /brew-review looks for what they describe.

## claude-md-follows-the-design-it-summarises (semantic)

A change that alters a design CLAUDE.md summarises (where a process runs, which sandbox holds it, the flags of a command it lists) updates that CLAUDE.md line in the same change, not only the design page.
