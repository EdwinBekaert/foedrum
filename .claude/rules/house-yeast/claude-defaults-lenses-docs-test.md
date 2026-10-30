---
paths:
  - "**/.claude/**"
  - "**/defaults/lenses/**"
  - "**/docs/**"
  - "**/test/**"
---

<!-- Generated from .foedrum/house-yeast/ by npm run house-yeast:rules; do not edit. -->

# House yeast

Rules learned from reviews of Foedrum's own pull requests (ADR 0122), for the files this session reads or changes (ADR 0271). Follow them where your change meets them: /brew-review looks for what they describe.

## prose-counts-follow-the-folder-they-describe (semantic)

A change that adds a file to a folder other code or a skill reads by glob (defaults/lenses/diff/) updates every prose count and list of that folder's files (the five default lenses), in skills, agent descriptions and test comments too, since the glob already reads the new file.
