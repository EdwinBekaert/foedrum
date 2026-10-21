# 0100. Nip ships with a default Cellarman, and the default brewers name the builder alias

Date: 2026-10-21 · Status: Accepted · Amends [0098](0098-foedrum-s-defaults-load-under-the-brewery-s-files-and-a-brewer-input-can-name-a-lens.md) (the first default brewers and recipe)

## Context
#218 adds the Gauger (`defaults/brewers/gauger.md`) and Nip (`defaults/recipes/nip.jsonc`), the first default brewer and recipe ([ADR 0017](0017-test-first-recipes-and-tasting-lenses.md)). Nip runs gauge → red proof → Cellarman → checks → `openPullRequest`. Three things follow from ADR 0098 that the issue did not settle:

- **Nip names Cellarman, which had no default.** A default recipe loads under every Brewery, all or nothing: one that names a brewer neither the Brewery nor the defaults have fails the load (`it names no brewer "cellarman" …`). Without a default Cellarman, every Brewery without its own `brewers/cellarman.md` would stop loading.
- **Nip's Taster step does not load.** The step `lens` field still fails the load (ADR 0053), and there is no default Taster.
- **A default brewer names a model alias.** `foedrum serve` checks the alias of every brewer in use, the defaults' included (ADR 0098), so every Brewery that keeps a default brewer needs its alias in `models.jsonc`.

## Decision
- **A default Cellarman** (`defaults/brewers/cellarman.md`) ships with the Gauger. It takes the order and the Gauger's out doc (`step:gauge`, left out when `testFirst` skipped the step), carries the `testsUnchanged` guard, and holds only what the attempt plan carries today (ADR 0059): no house yeast, no `context: repo`, no guard beyond `requiresOutDoc`, `requiresCommits` and `testsUnchanged`. The richer example in brewers-and-recipes §1.2 stays the target as the plan learns those fields.
- **Nip ships without its Taster step**: gauge → red → implement → green (`build`, `lint`, `format`, `test`) → `openPullRequest`. The Taster step joins once lens steps load (#26). A red proof that fails sends the batch back to the Gauger once (`onFail`), a failed green check back to Cellarman once, and a Cellarman that ends `blocked` + `findings` (a test it believes wrong) back to the Gauger once (`onBlocked`, [ADR 0064](0064-test-first-recipes-when-onblocked-and-a-red-proof-required.md)); after that the batch is Stuck.
- **The default brewers name the alias `builder`**, the alias the docs' examples use. A Brewery that keeps a default brewer maps `builder` in its `models.jsonc`, or replaces the brewer with a file of its own; `foedrum serve` refuses to start otherwise, naming the default's file (`defaults/brewers/gauger.md: models.jsonc has no model for the alias "builder" …`).
- **The Gauger's rules come from the lens**: its only lens input is `test-design` (`"from": "lens:test-design"`, ADR 0022), and its instructions open with what the engine checks after it: stubs throw `not implemented` (#46, #47), and test names are the ones the runner reports, as plain literals in their declarations, since the red proof finds the tests by those names in the committed lines (ADR 0078).

## Consequences
- Every Brewery gets Nip, the Gauger and Cellarman, and needs `builder` in `models.jsonc` unless it replaces both brewers. The demo's `models.jsonc` maps it.
- A Brewery whose own `cellarman.md` differs from Nip's needs (another out doc, other inputs) still loads: Nip uses whichever Cellarman the Brewery has, as it uses any brewer of that name.
- The Gauger's test rules and the Taster's test-design review read one file; a change to the lens reaches both.
- A Gauger sent back by a route is not yet told why: as for a check's `onFail` (ADR 0078), Cellarman's findings are in the event log, not in the Gauger's prompt. It starts afresh on top of its earlier tests.
- Cellarman's prompt is exercised only through the fake runner here; its first real run is in the end-to-end test of #180.

## Alternatives considered
- **Nip without Cellarman, or Nip only when the Brewery has one.** A default recipe that does not load stops every Brewery (ADR 0098), and a recipe that loads only sometimes is what ADR 0098's all-or-nothing load refuses.
- **A family alias such as `sonnet`.** Readable, but an alias names a role so blind tasting can swap its model; `builder` is the role both brewers play, and the one the docs already use.
- **Copying the lens checklist into the Gauger.** Two copies drift; ADR 0022 makes the lens the one source.
