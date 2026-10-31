---
paths:
  - "**/src/engine/**/*.ts"
---

<!-- Generated from .foedrum/house-yeast/ by npm run house-yeast:rules; do not edit. -->

# House yeast

Rules learned from reviews of Foedrum's own pull requests (ADR 0122), for the files this session reads or changes (ADR 0271). Follow them where your change meets them: /brew-review looks for what they describe.

## step-recipe-per-attempt (semantic)

A batch's folded steps keep the attempts of every recipe it brewed, since a person can choose another recipe; code that reads a step's definition for an attempt takes the recipe the attempt was scheduled under from the events, never batch.recipe alone.
