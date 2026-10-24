---
{
  "id": "assert-text-only-the-behaviour-writes",
  "scope": {
    "globs": [
      "test/**/*.ts"
    ],
    "lens": "test-design"
  },
  "kind": "semantic",
  "source": "https://github.com/EdwinBekaert/foedrum/pull/375 finding 1 (test-design), https://github.com/EdwinBekaert/foedrum/pull/474 finding 1",
  "created": "2026-10-24",
  "status": "active"
}
---
A test that shows a text reached a prompt, a body or an output matches text only the behaviour under test writes there, never text the fixture's own input (the order, a file it read) also holds, and asserts the same pattern is absent where the behaviour did not run.
