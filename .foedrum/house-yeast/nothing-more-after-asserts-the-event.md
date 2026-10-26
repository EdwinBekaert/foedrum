---
{
  "id": "nothing-more-after-asserts-the-event",
  "scope": {
    "globs": [
      "test/**/*.test.ts"
    ],
    "language": "typescript",
    "lens": "test-design"
  },
  "kind": "semantic",
  "source": "https://github.com/EdwinBekaert/foedrum/pull/356 finding 1 (test-design), https://github.com/EdwinBekaert/foedrum/pull/555 finding 9",
  "created": "2026-10-26",
  "status": "active"
}
---
A test that asserts nothing more happens once an event has happened first asserts that the event happened, so the negative check cannot pass when the event never came.
