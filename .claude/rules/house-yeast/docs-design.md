---
paths:
  - "**/docs/design/**"
---

<!-- Generated from .foedrum/house-yeast/ by npm run house-yeast:rules; do not edit. -->

# House yeast

Rules learned from reviews of Foedrum's own pull requests (ADR 0122), for the files this session reads or changes (ADR 0271). Follow them where your change meets them: /brew-review looks for what they describe.

## design-lists-gain-what-the-change-adds (semantic)

A change that adds an event, a command, a refusal or a status line updates every design page that lists such things one by one, not only the page of its own concept.

## design-page-checks-each-fact-against-its-owner (semantic)

A design page that restates a fact another page or ADR owns (what the state branch holds, what a retry does on its fallback paths, which marks before a name still declare a test) states it as that owner does, with each of its conditions, and links the owner.
