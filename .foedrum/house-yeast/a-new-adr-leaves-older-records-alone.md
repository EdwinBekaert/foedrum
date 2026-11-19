---
{
  "id": "a-new-adr-leaves-older-records-alone",
  "scope": {
    "lens": "design-conformance"
  },
  "kind": "semantic",
  "source": "https://github.com/EdwinBekaert/foedrum/pull/1167 (design-conformance finding: ADR 0174 edited), CLAUDE.md Git and pull requests",
  "created": "2026-11-19",
  "status": "active"
}
---
A decision record is never edited once merged: a change is a new ADR whose status line says what it amends or supersedes, and nothing else in `docs/adr/` changes, neither an older record's status line or text nor `docs/adr/README.md`'s table.
