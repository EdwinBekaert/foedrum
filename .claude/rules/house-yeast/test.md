---
paths:
  - "**/test/**"
---

<!-- Generated from .foedrum/house-yeast/ by npm run house-yeast:rules; do not edit. -->

# House yeast

Rules learned from reviews of Foedrum's own pull requests (ADR 0122), for the files this session reads or changes (ADR 0271). Follow them where your change meets them: /brew-review looks for what they describe.

## every-problem-at-once-tested-with-two (semantic)

A load that promises every problem at once has a test with two of its inputs broken together that asserts a line for each, so giving up at the first problem fails a test.
