# 0159. foedrum brewers reports each brewer's attempts, outcomes, Stuck batches and tokens

Date: 2026-10-23 · Status: Accepted · Amends [0030](0030-only-commands-that-change-state-are-recorded.md) (one more read-only command)

## Context
The ledger records every attempt of a step: when it started, how it ended (`step.finished`'s `outcome`) and, for a brewer step, the tokens it used (`usage`: input, output, cache read, cache write). Nothing reads those back per brewer. A team that writes its own brewers needs to see which ones earn their place: how often each runs, how it ends, which batches it left Stuck, and what it costs (#283). `foedrum doctor` already says what a brewer's own files put into every prompt and which Brewery files nothing uses ([ADR 0141](0141-doctor-reports-prompt-sizes-unused-files-and-what-a-brewery-file-drops-from-its-default.md)); this is the other half, what the runs actually spent.

Two things had to be settled. The events name a batch's step, never its brewer: the brewer comes from the recipe the batch ran (`batch.recipe_chosen`), and the recipe file may have changed since, or lost the step ([ADR 0059](0059-attempt-plans-from-the-brewer-of-the-step.md)'s divergence). And doctor reads the machine and the files, never the store: it must work before there is a Brewery.

## Decision
- **A read-only command of its own: `foedrum brewers`.** It reads the store as `status` and `stuck` do, without a lease, appends nothing and pushes nothing (ADR 0030), and loads the Brewery's recipe, brewer and lens files with the loader the engine uses (`loadRecipes`, ADR 0053); files that do not load refuse it with doctor's line. Doctor stays about the machine and the files: a section of doctor would make it open the store, which it does not need and may not have.
- **Terminal only.** It is a maintainer's report on the Brewery's brewer files, read where they are edited, so the registry marks it `terminalOnly` with that reason (ADR 0125); `/foedrum:status` and `/foedrum:stuck` stay the plugin's reads of the batches.
- **A step's brewer, through the batch's recipe as its file is now.** The report folds the events and, for each attempt of each batch, asks the loaded recipe the batch chose for the brewer of that step (`StepBrewers.find`). A check step has no brewer and is left out. An attempt whose recipe no file has now, or whose recipe has no such step any more, is not given to any brewer: the report lists it under `Steps the recipe files no longer have`, by recipe and step, with the same counts, so no attempt is dropped silently. A step whose file now names another brewer than the one that ran is counted for the one it names now: the events do not record the brewer, and recording it would be a new field on `step.started` for a report.
- **A pure function over the folded state** (`brewerReport`, `src/cli/brewer-report.ts`), given the brewers in use and a step lookup, gives per brewer:
  - **attempts**: the attempts of its steps that started (one scheduled and never started did not run);
  - **outcomes**: the finished ones by `outcome.kind` (`succeeded`, `failed`, `needs_input`, `cancelled`), and `unfinished` for one that started and has not finished (running now, or abandoned when its batch went Stuck, ADR 0025). A blocked out doc is recorded as a failure that is not retried (ADR 0059's `finish`), so it counts as `failed`;
  - **Stuck**: the batches Stuck now at a step of it, by id. The folded state keeps a batch's current lane only; a batch that was Stuck and has moved on is not counted, and its attempts' outcomes still say how they ended;
  - **tokens**: the sum of `usage` over its finished attempts, each of the four counts on its own.
- **Every brewer in use is listed**, also with no attempts, in the order of their names, with its file, so the report lines up with doctor's unused-file notice (ADR 0141): a brewer with nothing beside it is one no batch ran.

## Consequences
- A maintainer sees, from the terminal, which brewers run, how they end, which batches they hold Stuck and what they cost, at no cost: no model call, no lease, no event.
- A recipe file edited between batches changes which brewer an old attempt counts for when a step keeps its id and names another brewer; a step that left its file shows on a line of its own.
- The registry has one more read-only command, and the command list of the design page with it.
- Token counts are what claude reported; an attempt that ended before claude's report has none and adds nothing to the sums.

## Alternatives considered
- **A section of `foedrum doctor`.** One place for a maintainer, but doctor would open the store, and its checks of the machine run before there is one.
- **Record the brewer on `step.started`.** It would name the brewer that really ran, also after the file changed, but adds a field to the event schema for a report, and old events would still need the recipe.
- **Read the events instead of the folded state.** It would also count batches that were Stuck and moved on, but repeats the fold's work in a second place; the outcomes already show how each attempt ended.
- **A plugin skill.** The command reads only, so the plugin could carry it, but the report is for whoever edits the brewer files, which happens in the terminal; a skill can come when someone asks for it in a session.
