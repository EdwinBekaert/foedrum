# 0398. tasting-compare --real measures Cellarman with and without the Maltster's map

Date: 2026-11-14 · Status: Accepted · Amends [0394](0394-tasting-compare-real-runs-a-real-cellarman-on-a-model-and-effort-it-is-given.md) (a `--brewer` run can map the code first, and every brewer's run records each step's search and read calls) and [0396](0396-tasting-compare-real-starts-a-cellarman-run-from-the-brewmaster-s-kept-sub-order.md) (a `-plan` setup's name can hold `-map` before its end, and `codes.md` gains columns beside `Text`)

## Context
Since [ADR 0395](0395-the-maltster-maps-the-code-an-order-touches-before-the-gauger-on-the-explorer-alias.md) `nip` and `deep-brew` run the Maltster's `map` step before the Gauger, and the Gauger, Cellarman and the Finer read its map as `step:map`.
ADR 0395 measured reading and searching as 82% of Cellarman's tool output before the map, and left whether the map changes that to a measure.
The brewer runs of [ADR 0394](0394-tasting-compare-real-runs-a-real-cellarman-on-a-model-and-effort-it-is-given.md) record tokens, turns and time per step, but no count of the calls a brewer spent searching.
The question, answered after the merge by a run by hand: does Cellarman with the map write the code as well, for fewer tokens, and how often does it still search?

## Decision
- **`--map` on a `--brewer cellarman` run puts a real `map` step first**, `{ "id": "map", "brewer": "maltster-map" }`, before the scripted Gauger.
  The step names no model or effort, so it runs on the Maltster's own as it ships, as `nip`'s does; the scratch Brewery's `models.jsonc` only adds the measured brewer's alias over the default ones.
  Cellarman reads the map through the input its file already has; no brewer, recipe or Brewery file changes.
  `--map` without `--brewer` is refused in one line. It combines with `--order-text plan`, `--orders` and `--comparison` as any brewer run does; with `--order-text plan` the map reads the kept sub-order text as its order.
- **A run with a map is a setup of its own**: its name gains `-map` before any `-plan`, such as `855-cellarman-claude-sonnet-5-5-high-map-plan`, so runs with and without a map share one comparison folder and their lists are blinded together.
  Its settings carry `map: true`, and its record the models its map step's transcripts name.
- **The map's model stops nothing.** Unlike Cellarman's ([ADR 0344](0344-tasting-compare-real-measures-a-stronger-model-and-more-effort-apart.md)), it is not the setting measured; `codes.md` shows it, so a map on another model shows when the scores are read.
- **Every brewer's run counts each step's `Grep`, `Glob` and `Read` calls** from its sessions' transcripts: each call once by its id, whatever came of it, summed over the step's attempts.
  A step with a session whose transcript cannot be found, such as the scripted Gauger's on a real run, or holds a line that cannot be read, has no count, so a count never stands for part of its attempts; a check step has no session.
  A dry run's scripted transcripts each hold one `Read`, so its counts show the columns, not a measure.
- **`codes.md` gains three columns on every brewer's run**: `Map`, `no` or `yes` with the map's models; `Grep, Glob, Read`, per step, such as `map 4/3/12, implement 2/0/9`; and `Map tokens`, the map step's total.
  `Tokens`, `Turns` and `Brewers` stay the sums over every step, so a run with a map counts what the map cost.
  The lists show only each run's code diff, as before, so a scorer reads nothing of the map.
- **A run without `--map` brews as it did**: its recipe, Brewery files, setup and list do not change; its record gains the counts, and its `codes.md` row the new columns.
- A map step that fails its attempts leaves the batch Stuck before Cellarman, so that run measured nothing and is brewed once more, as ADR 0394's runs are.
- `--dry-run` scripts the map step too, with no file and a one-line summary.
- **A Brewery need do nothing:** nothing in one changes, and this runs only by hand in scratch folders.

## Consequences
- No number exists when this record is accepted: the maintainer runs Cellarman with and without `--map` in one comparison and scores the lists blind against #879's key.
- Old records have no counts: their rows show `-` there, and `no` for the map.
- The scripted Gauger reads no map, so the measure is of Cellarman alone, not of the Gauger and the Finer that `nip` also gives the map.
