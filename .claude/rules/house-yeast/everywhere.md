---
paths:
  - "**/*"
---

<!-- Generated from .foedrum/house-yeast/ by npm run house-yeast:rules; do not edit. -->

# House yeast

Rules learned from reviews of Foedrum's own pull requests (ADR 0122), for the files this session reads or changes (ADR 0271). Follow them where your change meets them: /brew-review looks for what they describe.

## comments-follow-a-redefined-glossary-term (semantic)

A change that redefines a glossary term also rewrites the code comments and schema docs that use the old meaning, not only the design pages, since a reader of the source takes the term from there.

## no-compatibility-before-the-first-publish (semantic)

Before the first publish (M7) nothing old has to keep working: a changed format, field, file or name changes everywhere in the same change, with no optional field, alias, fallback, migration code or second reading kept for data written before it, and a new field is required unless the design itself makes it optional; an order's "Migration: none until the first publish" means exactly this, never "make it optional".
