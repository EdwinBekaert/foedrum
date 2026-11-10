---
{
  "id": "removed-test-checked-against-the-records",
  "scope": {
    "globs": [
      "test/**/*.test.ts"
    ]
  },
  "kind": "semantic",
  "source": "https://github.com/EdwinBekaert/foedrum/pull/901 finding 1, https://github.com/EdwinBekaert/foedrum/pull/979 finding 1 (acceptance)",
  "created": "2026-11-10",
  "status": "active"
}
---
A change that removes a test first searches docs/adr/ and docs/design/ for its file, its name and, in words, the case it covers (a real junction or link): a test a decision record names stays, or a new ADR amends that record in the same change.
