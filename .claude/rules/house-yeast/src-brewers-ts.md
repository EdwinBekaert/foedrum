---
paths:
  - "**/src/brewers/**/*.ts"
---

<!-- Generated from .foedrum/house-yeast/ by npm run house-yeast:rules; do not edit. -->

# House yeast

Rules learned from reviews of Foedrum's own pull requests (ADR 0122), for the files this session reads or changes (ADR 0271). Follow them where your change meets them: /brew-review looks for what they describe.

## stall-clock-starts-with-the-model (semantic)

Work a brewer runner does before claude starts (an install, a plan) reports progress while it runs, and claude's stall clock starts when that work ends, so the stall limit judges only the model.
