---
{
  "id": "expected-output-never-from-the-code-under-test",
  "scope": {
    "globs": [
      "test/**/*.ts"
    ],
    "lens": "test-design"
  },
  "kind": "semantic",
  "source": "https://github.com/EdwinBekaert/foedrum/pull/377 finding 8, https://github.com/EdwinBekaert/foedrum/pull/1150 finding 6",
  "created": "2026-11-17",
  "status": "active"
}
---
A test builds its expected output from its fixtures and the files it reads, never by calling the function under test or reading the output back, so a wrong value cannot appear on both sides of the comparison.
