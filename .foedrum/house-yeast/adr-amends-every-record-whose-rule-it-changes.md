---
{
  "id": "adr-amends-every-record-whose-rule-it-changes",
  "scope": {
    "globs": [
      "docs/adr/*.md"
    ],
    "lens": "design-conformance"
  },
  "kind": "semantic",
  "source": "https://github.com/EdwinBekaert/foedrum/pull/346 finding 2 (design-conformance), https://github.com/EdwinBekaert/foedrum/pull/365 finding 7",
  "created": "2026-10-22",
  "status": "active"
}
---
A new ADR status line names every older record whose table or rule it changes, not only the newest one it builds on, because the ADR index back-links only from Amends links.
