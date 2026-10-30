---
paths:
  - "**/scripts/**/*.ts"
  - "**/src/**/*.ts"
---

<!-- Generated from .foedrum/house-yeast/ by npm run house-yeast:rules; do not edit. -->

# House yeast

Rules learned from reviews of Foedrum's own pull requests (ADR 0122), for the files this session reads or changes (ADR 0271). Follow them where your change meets them: /brew-review looks for what they describe.

## guard-on-two-paths-tested-on-each (semantic)

When the same guard or early return is written on two code paths (a check step and a red proof), each path has a test that reaches it, so deleting either copy fails a test.
