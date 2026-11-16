---
paths:
  - "**/tasting-room/orders/**"
---

<!-- Generated from .foedrum/house-yeast/ by npm run house-yeast:rules; do not edit. -->

# House yeast

Rules learned from reviews of Foedrum's own pull requests (ADR 0122), for the files this session reads or changes (ADR 0271). Follow them where your change meets them: /brew-review looks for what they describe.

## flight-order-trap-has-one-reading (semantic)

A tasting-room order's text, instruction file and hidden tests admit one reading of its trap: a solution that follows them to the letter passes the hidden tests, and only one that misses the trap fails them.
