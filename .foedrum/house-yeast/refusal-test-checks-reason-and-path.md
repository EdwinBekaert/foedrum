---
{
  "id": "refusal-test-checks-reason-and-path",
  "scope": {
    "globs": [
      "test/**/*.ts"
    ]
  },
  "kind": "semantic",
  "source": "https://github.com/EdwinBekaert/foedrum/pull/443 finding 3, https://github.com/EdwinBekaert/foedrum/pull/1157 finding 11",
  "created": "2026-11-17",
  "status": "active"
}
---
A test that a schema refuses a value checks the path of the issue it expects, and shows the same input without that value accepted, never only that the parse failed.
