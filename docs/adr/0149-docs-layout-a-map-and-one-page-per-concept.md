# 0149. Docs layout: a map, and one page per concept under docs/design/

Date: 2026-10-22 · Status: Accepted

## Context
`docs/architecture.md` had grown to 626 lines and 122 KB, about 30,000 tokens, and every session reads it (CLAUDE.md, Where things are).
Most of it was written one paragraph per line: 11 lines were longer than 2,000 characters, the longest 6,206.
Git merges line by line, so two pull requests that change different sentences of one paragraph always conflict.
On 2026-10-22 the file changed in 74 commits and caused most of the day's merge conflicts.
It also stated facts that live elsewhere: its §4.1 copied the event union of `src/schemas/events.ts` (49 edits since 2026-10-15, the most of any section), its §6 restated `docs/brewers-and-recipes.md`, and function names, limits and deadlines repeated the ADRs.

## Decision
- **`docs/architecture.md` is the map:** purpose, goals, concepts, the system diagram, and one short paragraph per part with links.
  It changes when a part is added, not when a part changes.
- **Topic pages live in `docs/design/<area>/`**, one concept per page: `engine/`, `intake/`, `recipes/`, `checks/`, `humans/`, `testing/`, `platform/`, and single pages for security, token economy, evaluation, extensibility, house yeast, delivery and layout.
  Each area has a `README.md` that lists its pages.
  `docs/brewers-and-recipes.md` becomes `docs/design/recipes/`.
  `docs/glossary.md`, `docs/trust-boundaries.md`, `docs/adr/` and `docs/milestones/` stay where they are.
- **A new concept gets a new page**, and the map gets a link line.
- **One owner per fact.** A fact is stated on the page that owns it; other pages link to it and do not restate it.
- **Code shapes are linked, not copied:** a page names the source file of a type or schema (`src/schemas/events.ts`) and says what it records, not its fields.
- **One sentence per line** in every page (semantic line breaks).
  The rendered page is the same, and git merges edits to different sentences.
- **A pull request updates the page it changes, in the same pull request**, as before; with small pages that is cheap, and the pages stay current for the sessions that read them.
- The old section numbers keep working: `docs/architecture.md` ends with a table of where each old section went, and `docs/brewers-and-recipes.md` is a stub with its old headings and links.
  ADRs are never edited, so their links and "architecture §13" references land there.
- The design pages are the review's criteria, so they are reviewed like the top-level docs: the gate's plain-documentation exemption from a review summary (#183) does not cover `docs/design/`.

## Consequences
- A session reads the map and the pages it needs, not 30,000 tokens.
- Two pull requests conflict in the docs only when they change the same sentence.
- The move dropped the copies of code shapes (the event union and the types beside it, the step outcome union): their fields are read in `src/schemas/`.
- The review skill reads `docs/design/` as it read the two files, and finds the ADRs to check from the pages a diff changes.
