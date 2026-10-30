---
paths:
  - "**/src/**/*.ts"
---

<!-- Generated from .foedrum/house-yeast/ by npm run house-yeast:rules; do not edit. -->

# House yeast

Rules learned from reviews of Foedrum's own pull requests (ADR 0122), for the files this session reads or changes (ADR 0271). Follow them where your change meets them: /brew-review looks for what they describe.

## fallback-tested-where-only-it-answers (semantic)

A lookup with a fallback (`a ?? b`) has a test where only the fallback can give the expected value, since tests whose state always fills the first value, or that expect undefined, pass with the fallback removed.

## key-part-tested-with-a-second-value (semantic)

When a map key gains a part (an attempt number, a repository), a test holds two keys that differ only in that part, so code that builds the part from a constant or leaves it out fails a test.

## linear-regex-on-brewery-text (semantic)

A regular expression run over text from a Brewery, an order, a repository or a model is linear in its input: no two adjacent quantifiers can match the same characters, and a global search whose run can fail after it starts only at the run's first character (a lookbehind), so a failed search does not rescan the run from each of its characters.
