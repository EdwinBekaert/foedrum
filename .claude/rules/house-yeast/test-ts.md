---
paths:
  - "**/test/**/*.ts"
---

<!-- Generated from .foedrum/house-yeast/ by npm run house-yeast:rules; do not edit. -->

# House yeast

Rules learned from reviews of Foedrum's own pull requests (ADR 0122), for the files this session reads or changes (ADR 0271). Follow them where your change meets them: /brew-review looks for what they describe.

## assert-text-only-the-behaviour-writes (semantic)

A test that shows a text reached a prompt, a body or an output matches text only the behaviour under test writes there, never text the fixture's own input (the order, a file it read) also holds, and asserts the same pattern is absent where the behaviour did not run.

## fakes-answer-with-distinct-values (semantic)

A fake that answers with a value the code under test also holds (the commit it was given, the same folder it made before) gets a distinct one in the test, so the test can tell which value the code passed on.

## near-miss-for-every-rule-of-a-text-form (semantic)

When code recognises a documented text form, every constraint of that form (one line, what may follow a separator, which names are allowed) has a near-miss test that reaches each branch of the matcher the constraint applies to, so dropping a flag or a character class from the pattern fails a test.
