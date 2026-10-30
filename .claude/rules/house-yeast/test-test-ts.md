---
paths:
  - "**/test/**/*.test.ts"
---

<!-- Generated from .foedrum/house-yeast/ by npm run house-yeast:rules; do not edit. -->

# House yeast

Rules learned from reviews of Foedrum's own pull requests (ADR 0122), for the files this session reads or changes (ADR 0271). Follow them where your change meets them: /brew-review looks for what they describe.

## nothing-more-after-asserts-the-event (semantic)

A test that asserts nothing more happens once an event has happened first asserts that the event happened, so the negative check cannot pass when the event never came.
