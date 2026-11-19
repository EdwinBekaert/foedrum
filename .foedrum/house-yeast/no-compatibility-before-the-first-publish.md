---
{
  "id": "no-compatibility-before-the-first-publish",
  "scope": {
    "lens": "design-conformance"
  },
  "kind": "semantic",
  "source": "https://github.com/EdwinBekaert/foedrum/pull/1168 (an optional tasted field kept for entries written before it), https://github.com/EdwinBekaert/foedrum/issues/977, https://github.com/EdwinBekaert/foedrum/issues/931",
  "created": "2026-11-19",
  "status": "active"
}
---
Before the first publish (M7) nothing old has to keep working: a changed format, field, file or name changes everywhere in the same change, with no optional field, alias, fallback, migration code or second reading kept for data written before it, and a new field is required unless the design itself makes it optional; an order's "Migration: none until the first publish" means exactly this, never "make it optional".
