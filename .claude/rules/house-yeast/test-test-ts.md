---
paths:
  - "**/test/**/*.test.ts"
---

<!-- Generated from .foedrum/house-yeast/ by npm run house-yeast:rules; do not edit. -->

# House yeast

Rules learned from reviews of Foedrum's own pull requests (ADR 0122), for the files this session reads or changes (ADR 0271). Follow them where your change meets them: /brew-review looks for what they describe.

## negative-test-reaches-the-reporting-path (semantic)

A test that expects nothing to be reported gives the code under test an input that reaches the path that would report something, such as a removed line it must count as moved, so it fails against a stub that never reports.

## nothing-more-after-asserts-the-event (semantic)

A test that asserts nothing more happens once an event has happened first asserts that the event happened, so the negative check cannot pass when the event never came.

## removed-test-checked-against-the-records (semantic)

A change that removes a test first searches docs/adr/ and docs/design/ for its file, its name and, in words, the case it covers (a real junction or link): a test a decision record names stays, or a new ADR amends that record in the same change.
