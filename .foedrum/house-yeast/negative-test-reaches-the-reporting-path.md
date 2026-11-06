---
{
  "id": "negative-test-reaches-the-reporting-path",
  "scope": {
    "globs": [
      "test/**/*.test.ts"
    ],
    "lens": "test-design"
  },
  "kind": "semantic",
  "source": "https://github.com/EdwinBekaert/foedrum/pull/669 finding 3, https://github.com/EdwinBekaert/foedrum/pull/886 finding test-design 2",
  "created": "2026-11-06",
  "status": "active"
}
---
A test that expects nothing to be reported gives the code under test an input that reaches the path that would report something, such as a removed line it must count as moved, so it fails against a stub that never reports.
