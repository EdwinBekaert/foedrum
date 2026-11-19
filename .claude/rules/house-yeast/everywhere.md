---
paths:
  - "**/*"
---

<!-- Generated from .foedrum/house-yeast/ by npm run house-yeast:rules; do not edit. -->

# House yeast

Rules learned from reviews of Foedrum's own pull requests (ADR 0122), for the files this session reads or changes (ADR 0271). Follow them where your change meets them: /brew-review looks for what they describe.

## a-new-adr-leaves-older-records-alone (semantic)

A decision record is never edited once merged: a change is a new ADR whose status line says what it amends or supersedes, and nothing else in `docs/adr/` changes, neither an older record's status line or text nor `docs/adr/README.md`'s table.

## comments-follow-a-redefined-glossary-term (semantic)

A change that redefines a glossary term also rewrites the code comments and schema docs that use the old meaning, not only the design pages, since a reader of the source takes the term from there.

## commits-carry-no-attribution (semantic)

A commit message, pull request, issue or comment carries no "Generated with" line and no `Co-Authored-By` or `Co-authored-by` trailer naming a tool or model: the author is the person or Foedrum, never the agent.

## no-compatibility-before-the-first-publish (semantic)

Before the first publish (M7) nothing old has to keep working: a changed format, field, file or name changes everywhere in the same change, with no optional field, alias, fallback, migration code or second reading kept for data written before it, and a new field is required unless the design itself makes it optional; an order's "Migration: none until the first publish" means exactly this, never "make it optional".

## public-text-never-names-the-maintainer (semantic)

Public text (code, comments, docs, ADRs, commit messages, pull requests, issues) never names the maintainer: it says "the maintainer".

## scratch-files-in-the-checkout-tmp (semantic)

A scratch file, capture or script a change needs while it works goes in `.foedrum/tmp/` inside the checkout, never the system temp folder, a home folder or the repository's tracked tree.

## script-option-through-a-tested-function (semantic)

A script's command line is read by a function in its core module that a unit test runs, with a red step: the script itself only passes `process.argv` to it and acts on its values or its refusal, so no option or its error path is left untested wiring.
