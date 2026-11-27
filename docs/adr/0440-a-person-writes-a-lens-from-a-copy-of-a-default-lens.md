# 0440. A person writes a lens from a copy of a default lens

Date: 2026-11-26 · Status: Accepted · Amends [0141](0141-doctor-reports-prompt-sizes-unused-files-and-what-a-brewery-file-drops-from-its-default.md) (the words of doctor's notice for a Brewery lens nothing names)

## Context
A Brewery can hold its own lenses ([ADR 0098](0098-foedrum-s-defaults-load-under-the-brewery-s-files-and-a-brewer-input-can-name-a-lens.md), [ADR 0143](0143-lenses-in-two-folders-diff-and-plan.md)), but every page about lenses was a design page written for Foedrum's developers.
Nothing told a person how to write one (#1185).
Doctor's notice for a Brewery lens nothing names read `no brewer's input names the lens`, though a lens a recipe step names counts too (`catalog.named.lenses`), so it sent a person who had named the lens in a recipe to look for a brewer input.

## Decision
- **A person writes a lens from a copy of a default lens.** [Writing a lens](../design/recipes/writing-a-lens.md) tells them to find a default lens's path on doctor's `Defaults in use:` line, copy it to the Brewery's `lenses/diff/<name>.md` under a name no default has, change what it looks for, and add it to a recipe step; since a Brewery recipe replaces the default recipe of its name whole, they copy the recipe into `recipes/` too.
- **Foedrum ships no separate example lens, and `foedrum init` writes none.** The default lenses already are the examples, and the page links one rather than quoting it, so the two cannot drift apart.
- **Doctor's notice for a Brewery lens nothing names reads `no recipe step or brewer names the lens "<name>" (ADR 0141)`**, as the lens is named in either place.
- **Decided against on 2026-11-26:** an `init` question or example file, and a doctor line that lists the Brewery's own lenses.

### A Brewery's files
None: no file changes. Only the wording of one doctor notice changes.

## Consequences
- A person has one page from "what is a lens" to a lens in a recipe, linked from the recipes README, the README's documentation list and the glossary.
- A default lens that changes its sections changes what a copy starts from, and the page needs no edit while it names only the sections the defaults share.
- How a person knows a lens earns its tokens stays with #847 and #672.

## Alternatives considered
- **Ship an example lens, or have `init` write one:** a second file that drifts from the defaults, and a Brewery that carries a lens it never chose; the defaults already show every section.
- **List the Brewery's own lenses in doctor:** a line that repeats what the Brewery's folder shows, and the notice already names a lens nothing uses.
