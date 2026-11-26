# 0438. Doctor reports the Brewery files the brew setup refuses and reads an older event log as what it is

Date: 2026-11-26 · Status: Accepted · Amends [0419](0419-doctor-lists-the-untasted-models-in-use-and-the-cheaper-levels-a-tasting-could-try.md) (doctor's `Tasting:` lines and the sentence that the line is never a problem)

## Context
On 2026-11-19 `foedrum doctor` ended with "Foedrum has everything it needs." in a Brewery whose `models.jsonc` held an old form (`{ "models": { "builder": "claude-sonnet-5-5" } }`), while `foedrum recipe` printed `models.jsonc: ✖ Unrecognized key: "models"` and the setup that serve, brew and resume start through refused the file (#1163).
Doctor read `models.jsonc` only for its `Tasting:` line, which returned earlier on an event log it could not read, so the file's problem was never shown.
The `Tasting:` line also named `foedrum taste`, which does not exist until #1143, and said an event log in an older format could not be read, for a store the next `foedrum brew` or `foedrum serve` upgrades by itself: only a read-only open refuses it.

## Decision
- **One function checks the Brewery's files** (`breweryFileProblems`, `src/cli/serve-config.ts`), which `serveSetup` and doctor both call: the merged `models.jsonc` and Foedrum's default one, what `foedrum.jsonc` must hold (a repository, the Brewery's name, a user who may order work), a default recipe that is not of type `mash` ([ADR 0370](0370-foedrum-brew-runs-the-brewery-s-default-recipe-on-an-issue-with-no-recipe-label.md)), and the translation of each step's level and effort in `models.jsonc`.
  Its lines are the setup's, word for word, and all of them are given at once.
- **Doctor reports each such line as a required problem**, and so does not end with "Foedrum has everything it needs.", but only in a folder with a `foedrum.jsonc` that passes its schema, which tells it how the Brewery is read; in a folder with none it says nothing of these files, as before. A `foedrum.jsonc` that does not pass its schema is reported once, by its own problem.
  The recipe files that do not load keep their own problem ([ADR 0053](0053-recipe-files-reach-the-engine-brewer-steps-in-a-line-first.md)).
- **The `Tasting:` line points to how a Flight tastes a model**, `docs/design/evaluation.md`, in place of `foedrum taste`: `` Tasting: 1 model in use was never tasted (claude-opus-5-6 for cellarman); docs/design/evaluation.md says how a Flight tastes it. `` (`them` for more than one).
  It names no script: `scripts/` is not in the npm package, and an untasted model names no recipe or effort.
- **An event log in an older format reads as what it is.** Doctor reads the store's schema version, not the refusal's message: a store below this Foedrum's version is `` Tasting: the event log is in an older format (schema version 4); the next `foedrum brew` or `foedrum serve` upgrades it. ``, is no problem and is left as it was.
  A store newer than this Foedrum, or one that cannot be read, stays `Tasting: the event log cannot be read (<why>).`.
- **The `Tasting:` line is a problem no more than before**: it is never one. The sentence of 0419 that the line is never a problem holds for the line; a `models.jsonc` that does not load is a problem of its own, above it.

### A Brewery's files
None: no file changes. A Brewery whose `models.jsonc` the setup refuses already had to fix it; doctor now says so before a brew does.

## Consequences
- `foedrum doctor` and a refused `foedrum brew`, `serve` or `resume` print the same line for the same file.
- A change to what the setup checks of the Brewery's files shows in doctor with no second edit.
- A `models.jsonc` that cannot be read is still said only by the `Tasting:` line, once doctor read an event log.
- `foedrum taste` (#1143), when it comes, is the line's pointer again.

## Alternatives considered
- **Doctor checks `models.jsonc` on its own:** a second list of what the setup refuses, which drifts from it, as the file this change found did.
- **Report the files in a folder with no `foedrum.jsonc`:** a folder that is no Brewery would show problems of files it never reads.
- **Read the older store's version from the refusal's message:** a changed message would turn an older store into a problem again; the store's version does not change with it.
