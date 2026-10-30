---
{
  "id": "compare-paths-in-one-normal-form",
  "scope": {
    "language": "typescript"
  },
  "kind": "semantic",
  "source": "https://github.com/EdwinBekaert/foedrum/pull/437 finding 6, https://github.com/EdwinBekaert/foedrum/pull/674 finding 3",
  "created": "2026-10-30",
  "status": "active"
}
---
Code that compares two paths brings both sides to one form first (normalized, no trailing slash, and lower-cased where a case-insensitive file system such as macOS's can hold them), never only the side it builds itself.
