---
{
  "id": "design-page-checks-each-fact-against-its-owner",
  "scope": {
    "globs": [
      "docs/design/**"
    ],
    "lens": "design-conformance"
  },
  "kind": "semantic",
  "source": "https://github.com/EdwinBekaert/foedrum/pull/433 finding correctness 1, https://github.com/EdwinBekaert/foedrum/pull/479 finding 7",
  "created": "2026-10-24",
  "status": "active"
}
---
A design page that restates a fact another page or ADR owns (what the state branch holds, what a retry does on its fallback paths, which marks before a name still declare a test) states it as that owner does, with each of its conditions, and links the owner.
