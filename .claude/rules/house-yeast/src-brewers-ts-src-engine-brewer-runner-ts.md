---
paths:
  - "**/src/brewers/*.ts"
  - "**/src/engine/brewer-runner.ts"
---

<!-- Generated from .foedrum/house-yeast/ by npm run house-yeast:rules; do not edit. -->

# House yeast

Rules learned from reviews of Foedrum's own pull requests (ADR 0122), for the files this session reads or changes (ADR 0271). Follow them where your change meets them: /brew-review looks for what they describe.

## first-rule-wins-tested-against-every-lower-rule (semantic)

A rule in a first-rule-wins chain such as settleAttempt is tested against every rule below it, process exits included, so moving it down the chain fails a test.
