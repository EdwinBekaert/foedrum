---
{
  "id": "near-miss-for-every-rule-of-a-text-form",
  "scope": {
    "globs": ["test/**/*.ts"],
    "lens": "test-design"
  },
  "kind": "semantic",
  "source": "https://github.com/EdwinBekaert/foedrum/pull/346 finding 1 (test-design, round 1) and finding 5 (test-design, round 2), https://github.com/EdwinBekaert/foedrum/pull/353 finding test-design 3",
  "created": "2026-10-22",
  "status": "active"
}
---
When code recognises a documented text form, every constraint of that form (one line, what may follow a separator, which names are allowed) has a near-miss test that reaches each branch of the matcher the constraint applies to, so dropping a flag or a character class from the pattern fails a test.
