# 0405. The seeded comparison tastes on a given model and effort

Date: 2026-11-16 · Status: Accepted · Amends [0224](0224-the-default-recipes-taste-apart-or-together-as-a-seeded-comparison-measured.md) (its Tasters can run on another model and effort than the default `taster`'s `standard` at `moderate`) and [0394](0394-tasting-compare-real-runs-a-real-cellarman-on-a-model-and-effort-it-is-given.md) (`--model` and `--effort` without `--brewer` are refused only with `--real`)

## Context
Deep-brew tastes with one Taster through all seven diff lenses, on the `strong` level at `moderate` effort ([ADR 0366](0366-deep-brew-builds-a-change-that-can-reach-a-lot-through-every-diff-lens-and-a-blocking-brett-step.md)).
The seeded comparison's re-run of 2026-11-16 found that seven lenses in one Taster on Sonnet lost 4 of 21 lens defects over 3 runs, a different lens each time, while apart found all of them (#602).
Whether Opus loses defects the same way is not measured: the seeded comparison runs only `standard` at `moderate`, and the Taster settings of [ADR 0402](0402-tasting-compare-real-tastes-with-a-taster-setup-built-from-settings.md) are for `--real` only.

## Decision
- `node scripts/tasting-compare.ts --model <level or id> --effort <effort>` runs every Taster step of the three seeded setups on the given level, or on `strong` with the run's `models.jsonc` mapping `strong` to the given model id, as ADR 0402 maps them, at the given effort, one of Foedrum's four ([ADR 0397](0397-recipe-steps-name-a-model-level-and-an-effort-of-foedrum-s-own-which-models-jsonc-translates-for-the-agent.md)).
  No other step moves: the scripted implement step and the skipped Gauger stay on `standard`.
- Both options are required together, and refused with `--plan`; with `--real` they still need `--brewer`, as before.
- A run with them keeps its records, runs and table under `.foedrum/tmp/tasting-compare/seeded/<model>-<effort>`, the name made safe for a folder, so its numbers never mix with the default's or another setting's.
  The setups keep their names, `apart-7`, `together-7` and `together-nip`.
- Its table's first line names the model and effort asked and the models the Tasters' receipts named, such as `Tasters on strong at moderate; ran on claude-opus-5-5`, or `ran on: not named` when no receipt names one, as in a dry run.
  A run on a model it did not ask for does not stop the comparison: every Taster step prints the model it was planned with, and the line shows what it ran on.
- A run without them is as before: the same recipes, no `models.jsonc`, and the same folder and table.
- The level, `models.jsonc` and option checks are the ones `--real --brewer taster` uses, shared in `scripts/tasting-compare/core.ts`.

### A Brewery's files
None: this is a script of Foedrum's own repository, and no Brewery file changes, so no Brewery needs a migration.

## Consequences
- Deep-brew's together-7 setup on Opus is measured with a command line: `node scripts/tasting-compare.ts --model strong --effort moderate`.
- Each setting is a comparison of its own: ADR 0224's rule can be read within one setting's table, never across two.

## Alternatives considered
- **Stopping on a model the run did not ask for, as `--real` does** ([ADR 0344](0344-tasting-compare-real-measures-a-stronger-model-and-more-effort-apart.md)): the receipts already name the models, and the scripted dry run's name none, so a stop could not be shown before a real run; the table's first line shows the same fact to the person who reads the result.
- **New setup names per setting, in the default folder**: the 2026-11-16 records would sit beside an Opus run's, and every reader of the folder would have to tell them apart.
