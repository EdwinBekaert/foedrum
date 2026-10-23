---
{
  "id": "fakes-answer-with-distinct-values",
  "scope": {
    "globs": [
      "test/**/*.ts"
    ],
    "lens": "test-design"
  },
  "kind": "semantic",
  "source": "https://github.com/EdwinBekaert/foedrum/pull/371 finding 1 (test-design, second round), https://github.com/EdwinBekaert/foedrum/pull/440 finding 5 (test-design, round 2)",
  "created": "2026-10-23",
  "status": "active"
}
---
A fake that answers with a value the code under test also holds (the commit it was given, the same folder it made before) gets a distinct one in the test, so the test can tell which value the code passed on.
