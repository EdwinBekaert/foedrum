# 0419. Doctor lists the untasted models in use and the cheaper levels a tasting could try

Date: 2026-11-17 · Status: Accepted · Amends [0383](0383-rack-archives-finished-batches-and-deletes-old-archive-folders-and-temporary-files.md) (rack archives a finished group only once its newest attempt's deadline is 30 days old) and [0416](0416-models-jsonc-keeps-a-tasted-list-the-latest-flight-of-each-brewer-recipe-level-and-effort.md) (doctor reads the merged tasted list)

## Context
`models.jsonc`'s `tasted` list keeps the latest Flight of each brewer, recipe, level and effort ([ADR 0416](0416-models-jsonc-keeps-a-tasted-list-the-latest-flight-of-each-brewer-recipe-level-and-effort.md)), and nothing read it yet.
A level names a family such as `opus`, which moves to each new model on its own, so a Brewery can run on a model nobody tasted, and a step on a dear level may do as well on a cheaper one.
Each brewer attempt's `step.finished` records the exact model claude's init event named ([ADR 0116](0116-the-driver-records-each-attempt-s-session-and-claude-s-report-goes-on-step-finished.md)).
Events carry no time of their own; each attempt's `step.scheduled` carries its deadline.
Rack forgot every finished group whose issues are closed, however recent ([ADR 0383](0383-rack-archives-finished-batches-and-deletes-old-archive-folders-and-temporary-files.md)), so right after a rack run the store held few finished attempts.
Decided with the maintainer on 2026-11-17 (#1142): two kinds of suggestion, read from the last 30 days of attempts, shown as one line in `foedrum doctor`; the full list comes with `foedrum taste` (#1143).

## Decision
- **A pure core lists the suggestions** (`tastingSuggestions`, `src/engine/tasting-suggestions.ts`), from the attempts that reported a model (`modelsUsed`), each step's brewer, level and effort as its recipe names it today, and the merged tasted list.
  An attempt counts when its `step.scheduled` deadline is at most 30 days old (`TASTING_DAYS`): it started before that deadline, so the window can take in an attempt that started up to its step's deadline earlier.
  Its recipe is the one its batch brewed when it was scheduled; an attempt whose step its recipe no longer has is left out.
  The step's level and effort are read from today's recipe files, since no event records them.
- **A model in use was never tasted** when no tasted entry of the step's brewer names that exact model id, whatever its recipe, level and effort (decided on 2026-11-17): a Flight tastes a brewer on a model.
  Each such model is listed once, with every brewer that ran it.
- **A cheaper level may do** for a step when its combination's entry was tasted on the model in use, did no worse than its baseline (as many orders measured, and as many passed or more), and the level one below has no entry of the same brewer, recipe and effort (decided on 2026-11-17).
  No worse, not every order passed: a brewer that passed 9 of 10 against a baseline's 8 does its job on that level, which is when a cheaper one is worth a Flight.
  The level below is the next of `light`, `standard`, `strong`, `extreme`; a `light` step gets none.
  Each step is listed once.
- **`foedrum doctor` shows one `Tasting:` line** under the isolation level, after the keep-awake line, reading the Brewery's event log read-only (it creates none, [ADR 0030](0030-only-commands-that-change-state-are-recorded.md)) and its `models.jsonc` merged over Foedrum's (`mergedModels`):
  - `` Tasting: 1 model in use was never tasted (claude-opus-5-6 for cellarman); `foedrum taste` will list it. ``
  - `` Tasting: 2 models in use were never tasted (claude-opus-5-6 for cellarman and gauger, claude-sonnet-5-6 for maltster) and 1 step may do on a cheaper level (gauger in nip on standard); `foedrum taste` will list them. ``
  - `Tasting: every model in use in the last 30 days was tasted, and no step has a cheaper level to taste.`
  - `Tasting: no brewer attempt in the last 30 days to read.`, also where the Brewery has no event log yet.
  - `Tasting: models.jsonc cannot be read (<why>).` or the merge's problem, when the file does not load.

  Brewers are named by their ids. A model id is claude's text, printed with its control characters and line breaks escaped. The line is never a problem, and doctor prints none when its recipes do not load.
- **Rack keeps a finished group until its newest attempt's deadline is 30 days old** (`finishedGroups`, `src/engine/rack.ts`, decided with the maintainer on 2026-11-17), with the same `TASTING_DAYS`, so the window holds 30 days after any rack run.
  A group with no attempt goes as before.

### A Brewery's files
None: no file changes. A person sees the `Tasting:` line in `foedrum doctor`, and finished batches stay in the store up to 30 days before rack archives them.

## Consequences
- A model a level moved to on its own shows in doctor once an attempt ran on it, until a Flight of that brewer on it is in the tasted list.
- Doctor's line can name a step only after a Flight of its combination, so with Foedrum's empty default list it lists models only.
- Rack archives a batch up to 30 days later than before; the store and `batches/` on the state branch hold that much more.
- `foedrum taste` (#1143) is to call the same core for the full list; until it comes, doctor is its only caller.
- A lower effort, a level that could switch model, and a result older than its recipe are later suggestions (#1148).

## Alternatives considered
- **Leave rack as it is and read what the store holds:** right after a rack run the line would say little or nothing.
- **Read the archive on the state branch:** ADR 0383 keeps Foedrum from reading it, and doctor would read git for one line.
- **Every order passed for a cheaper level:** a brewer at 9 of 10 would never be offered one.
- **A model covered only by an entry of the step's exact combination:** every recipe step would need a Flight of its own before its model stopped being listed.
- **A time on every event:** a schema change of every event for one window, where each attempt's deadline already dates it.
