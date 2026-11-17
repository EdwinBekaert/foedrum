---
paths:
  - "**/docs/**/*.md"
  - "**/src/**/*.ts"
---

<!-- Generated from .foedrum/house-yeast/ by npm run house-yeast:rules; do not edit. -->

# House yeast

Rules learned from reviews of Foedrum's own pull requests (ADR 0122), for the files this session reads or changes (ADR 0271). Follow them where your change meets them: /brew-review looks for what they describe.

## docs-of-a-variable-list-follow-the-code-that-builds-it (semantic)

A doc sentence about which environment variables a process gets, or which names a brewer's env may not set, is checked against the code that builds that list (brewerBaseEnv, terminalEnv, brewerForcedEnv, reservedEnv) when the list changes, so no sentence claims a name is rejected or reaches the process when the code says otherwise.
