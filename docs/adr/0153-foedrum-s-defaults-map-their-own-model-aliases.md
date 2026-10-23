# 0153. Foedrum's defaults map their own model aliases

Date: 2026-10-23 · Status: Accepted · Amends [0098](0098-foedrum-s-defaults-load-under-the-brewery-s-files-and-a-brewer-input-can-name-a-lens.md) (the defaults gain a `models.jsonc`, merged by alias), [0100](0100-nip-ships-with-a-default-cellarman-and-the-default-brewers-name-the-builder-alias.md) (who maps the `builder` alias), [0063](0063-foedrum-serve-its-configuration-and-wiring.md) (`models.jsonc` is optional, and the alias check runs on the merged models) and [0059](0059-attempt-plans-from-the-brewer-of-the-step.md) (the plan's model comes from the merged models)

## Context
A brewer names a model alias (`builder`), and a Brewery's `models.jsonc` maps each alias to a model id or family (`src/schemas/models.ts`), so blind tasting can swap the model behind a role.
Since [ADR 0100](0100-nip-ships-with-a-default-cellarman-and-the-default-brewers-name-the-builder-alias.md), the default Gauger and Cellarman name `builder`, and they load under every Brewery ([ADR 0098](0098-foedrum-s-defaults-load-under-the-brewery-s-files-and-a-brewer-input-can-name-a-lens.md)).
`serveSetup` (`src/cli/serve-config.ts`) refuses a Brewery without a `models.jsonc` (`models.jsonc: not found in …`), and one whose file has no `builder` (`models.jsonc has no model for the alias "builder" of the brewer "gauger"`), even a Brewery that never routes an order to Nip.
So a new Brewery does not start until someone writes a line that only repeats what Foedrum's own brewers need (#292; the first trial on Foedrum, #374, wrote it by hand).

## Decision
- **Foedrum ships `defaults/models.jsonc`**, next to `defaults/brewers/`, read from Foedrum's install as the other defaults are (`FOEDRUM_DEFAULTS`, ADR 0098). It maps every alias a default brewer names, today `{ "models": { "builder": "sonnet" } }`, and has no `brewers` part.
- **`builder` is the family `sonnet`, not a pinned id.** A default ships to every Brewery and outlives model releases: a family keeps resolving to a current model, as `claude --model sonnet` does. A Brewery that wants a fixed model, or blind tasting, pins one in its own file.
- **Merged by alias, under the Brewery's file.** The models a brewer can resolve are the default's `models` with the Brewery's `models` over them: a Brewery entry replaces the default of the same alias, and every other default alias stays. `brewers` comes from the Brewery's file only. This differs from recipes, brewers and lenses, which a Brewery file replaces whole (ADR 0098): `models` is a map of independent entries, not a document whose fields belong together, and replacing it whole would bring back the refusal this record removes for any Brewery that maps one alias of its own.
- **The Brewery's `models.jsonc` becomes optional.** Without it, the default's models apply. A file that is there and does not pass the schema still refuses the start with its line, as today.
- **The alias check runs on the merged models.** `serveSetup` checks every brewer in use against them, and so does the `brewers` part of the Brewery's file (`No model has the alias "<alias>"`), so a Brewery's `brewers` may name a default alias.
- **The same merge everywhere a brewer's model is resolved**: `foedrum serve`, `foedrum brew` and `foedrum resume` (`src/cli/serve-main.ts`, `src/cli/resume-main.ts`), through one function of the pure load, so the three cannot disagree.
- **`foedrum doctor` lists `defaults/models.jsonc` in `Defaults in use`** (ADR 0098), after the lenses, since its models always apply under the Brewery's. Doctor lists it without loading it: it still does not check `models.jsonc` (ADR 0063), and `serve` refuses a broken one. A Brewery's `models.jsonc` merges over it rather than replacing it, so it gets no notice of what it drops ([ADR 0141](0141-doctor-reports-prompt-sizes-unused-files-and-what-a-brewery-file-drops-from-its-default.md)).
- **A default that does not load is Foedrum's defect** (ADR 0098): a broken `defaults/models.jsonc` refuses every start with a line naming its `defaults/` path; Foedrum's own tests load it.

## Consequences
- A new Brewery with no `models.jsonc` starts, and the default brewers run on the current Sonnet.
- A Brewery that maps `builder` itself (the Brewery of #374 does, to `claude-sonnet-5-5`) keeps its model.
- A new default brewer that names a new alias adds it to `defaults/models.jsonc` in the same change, or every Brewery that keeps that brewer is refused.
- What a batch ran on is still the model id each attempt records, not the alias, so a family that moves on does not hide which model brewed what.

## Alternatives considered
- **`foedrum init` writes `builder` into a new Brewery's `models.jsonc`** (#404). Only new Breweries get it, init does not exist yet, and every Brewery would carry a copy of a fact that belongs to Foedrum's brewers.
- **Check only the aliases of brewers a routable recipe uses.** The check would depend on routing, which labels decide at run time (ADR 0098's alternatives), and Nip, a default every Brewery keeps, uses `builder` anyway.
- **Replace the default `models.jsonc` whole, as other defaults are.** A Brewery that maps any alias of its own would lose `builder` and be refused again.
- **Pin `builder` to a model id.** Reproducible, but every Brewery would run a model that gets older with each Foedrum release, and Foedrum would have to ship a change for each model release.
