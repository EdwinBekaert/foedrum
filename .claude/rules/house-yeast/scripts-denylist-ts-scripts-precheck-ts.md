---
paths:
  - "**/scripts/denylist.ts"
  - "**/scripts/precheck.ts"
---

<!-- Generated from .foedrum/house-yeast/ by npm run house-yeast:rules; do not edit. -->

# House yeast

Rules learned from reviews of Foedrum's own pull requests (ADR 0122), for the files this session reads or changes (ADR 0271). Follow them where your change meets them: /brew-review looks for what they describe.

## read-option-groups-as-the-parser-does (semantic)

Code that reads another tool's command-line options reads every option it looks for in all the forms that tool's flag parser takes: after other short options in one group (-iF value), joined to the option, after =, and a long option by any unique prefix, with options that take a value taking the next word.
