# 0397. Brewers name a model level and an effort of Foedrum's own, which models.jsonc translates

Date: 2026-11-14 · Status: Accepted · Amends [0059](0059-attempt-plans-from-the-brewer-of-the-step.md) (the call's effort is translated, and a missing translation fails the plan as a missing model does), [0063](0063-foedrum-serve-its-configuration-and-wiring.md) (serve also refuses an effort with no translation), [0153](0153-foedrum-s-defaults-map-their-own-model-aliases.md) (`models.jsonc` holds one block per agent that translates levels and efforts, merged entry by entry), [0321](0321-mash-and-decoction-review-a-plan-through-the-plan-lenses-apart.md) (a step's `model` names a level, not an alias), [0215](0215-an-opus-or-sonnet-limit-holds-only-the-brewers-of-its-family.md) (an attempt's family is read from its step's level, with no blind-tasting swap), [0352](0352-nip-s-correctness-acceptance-and-security-tasters-run-at-high-effort-without-the-rules-read.md) (a step's `effort` is one of Foedrum's four, and Nip's three Tasters run at `larger`), [0100](0100-nip-ships-with-a-default-cellarman-and-the-default-brewers-name-the-builder-alias.md) (the default brewers name `standard`, not `builder`), [0232](0232-foedrum-mash-routes-an-issue-to-the-innkeeper-whose-question-the-answer-chooses-the-recipe-by.md) (the Innkeeper is on `standard` at `small`), [0234](0234-the-brewmaster-writes-a-plan-on-the-planner-alias-and-mash-runs-it.md) (the Brewmaster is on `strong`, not `planner`), [0323](0323-a-seeded-plan-measures-the-plan-lenses-apart-and-together-after-the-merge.md) (its steps on `planner` name `strong`), [0366](0366-deep-brew-builds-a-change-that-can-reach-a-lot-through-every-diff-lens-and-a-blocking-brett-step.md) (Deep-brew's `taste` step is on `strong`), [0344](0344-tasting-compare-real-measures-a-stronger-model-and-more-effort-apart.md) (the `opus` setup swaps the Taster to `strong` with `brewers`, and `high` swaps `moderate` for `larger`), [0394](0394-tasting-compare-real-runs-a-real-cellarman-on-a-model-and-effort-it-is-given.md) (`--effort` takes Foedrum's four, and the measured step is on `strong`, not `measured`), [0395](0395-the-maltster-maps-the-code-an-order-touches-before-the-gauger-on-the-explorer-alias.md) (the Maltster's map is on `light`, not `explorer`) and [0396](0396-tasting-compare-real-starts-a-cellarman-run-from-the-brewmaster-s-kept-sub-order.md) (the Brewmaster is on `strong`, and the planning stop reads `strong`'s family)

## Context
A brewer names a model alias and one of Claude Code's five effort words (`low`, `medium`, `high`, `xhigh`, `max`), and `models.jsonc` maps each alias to a model: `builder` to `sonnet`, `planner` to `opus`, `explorer` to `haiku` ([ADR 0395](0395-the-maltster-maps-the-code-an-order-touches-before-the-gauger-on-the-explorer-alias.md)).
The aliases name a role, not a level: `deep-brew`'s Taster and the coverage and security plan Tasters run on `planner` to get Opus, so moving one brewer to another model means moving it to an alias named after another role.
The effort words are one agent's: a second agent (#691, #839) has its own words or none.
Decided with the maintainer on 2026-11-14 (#1058).

## Decision
- **Four model levels replace the aliases**: `light` (was `explorer`), `standard` (was `builder`), `strong` (was `planner`) and `extreme`, above `strong`, which no default brewer or step names (decided with the maintainer on 2026-11-14).
  The set is closed: a step names one of the four, and the schema refuses any other name.
- **Four efforts of Foedrum's own** replace Claude Code's five words: `small`, `moderate`, `larger` and `full`.
- **The recipe step is the one place a brewer's model and effort are named** (decided with the maintainer on 2026-11-14).
  Every brewer step names its `model` (a level) and its `effort`, in a parallel group and on an interactive step too, and a brewer file has neither: the brewer schema refuses either field.
  The recipe loader refuses a brewer step without them, with a line that names the recipe file, the step, its brewer and the field (`recipes/stout.jsonc: step "brew" of the brewer "cellarman" names no "model": …`); the schema keeps both fields optional, since a union of step kinds would only say `Invalid input` at the step's place.
  The same brewer can so run on two levels in two recipes with no override, and a reader finds what a step runs on in the recipe alone.
  When a step also names its agent (#691, #839), it names it there too.
  Every default recipe, the demo's and the comparison tool's write out what each step runs on; the default brewers' `version` goes up, since their files change, and their prompts do not.
- **`models.jsonc` holds one block per agent**, today one, `claude`, with `models` (a model id or family per level) and `efforts` (Claude Code's word per effort):

  ```jsonc
  { "claude": {
      "models": { "light": "haiku", "standard": "sonnet", "strong": "opus", "extreme": "fable" },
      "efforts": { "small": "low", "moderate": "medium", "larger": "high", "full": "xhigh" } } }
  ```

  That is `defaults/models.jsonc`.
  `extreme` is the family `fable`, which `claude --model` takes as an alias for the latest Fable model (its `--help` names it), as `opus` is for the latest Opus.
  `models.jsonc` has no `brewers` swap any more: a brewer moves to another model by its recipe steps, and a blind tasting brews a recipe copy whose step names another level.
- **The merge stays entry by entry** (ADR 0153): the merged `claude.models` is the defaults' with the Brewery's over them, level by level, and `claude.efforts` the same, effort by effort.
  A Brewery that wants the same effort everywhere writes `{ "claude": { "efforts": { "small": "medium", "moderate": "medium", "larger": "medium", "full": "medium" } } }` and nothing else.
- **The translation happens where the model's does**: `effortOf` beside `modelOf` (`src/brewers/attempt-plan.ts`), read by the attempt's plan, an interactive session and `foedrum resume`, so `claude --effort` gets Claude Code's word.
- **A level or an effort with no translation refuses the start**: `serveSetup` checks every brewer step's level and effort against the merged models and names the step and its brewer (`recipes/stout.jsonc: step "brew" of the brewer "gauger" names the effort "larger", which models.jsonc has no claude effort for`), as a missing alias did.
- **No brewer changes model or how hard it thinks.** Every default recipe step names the level and effort that translate to what it ran on before: `low` became `small`, `medium` `moderate`, `high` `larger`; nothing used `xhigh` or `max`.
- **`tasting-compare --real --brewer`'s `--effort` takes Foedrum's four efforts**, translated by the default efforts, so Claude Code's `max` cannot be measured by it without a Brewery of one's own that maps an effort to it.
  The measured step names `strong`, and the run's scratch Brewery maps only `claude.models.strong` to `--model`: no other step of `real-brew-cellarman` names `strong`, `light` and `standard` stay the defaults' (so a map step stays on Haiku), and no effort is mapped.
  The planning runs' scratch Brewery (`--sub-orders`) writes no `models.jsonc`, so the Brewmaster stays on the default `strong`.
  A run's setup ends in the Foedrum effort it was given, such as `855-cellarman-claude-opus-5-5-full`, not Claude Code's word.
  The `opus` setups' recipe copies name `strong`, Opus by default, on their Taster steps, and the `high` setups' name `larger`, instead of a `brewers` swap and an effort written into the Taster's text; their names and records stay as measured.
  The pinned Taster texts the setups start from, which named a model and an effort, are written without those two lines.

## What an existing Brewery must do
Nothing: no Brewery runs Foedrum before its first publish, so the rename and the move to the steps have no alias, migration or compatibility code, and a Brewery file with the old fields is refused.

## Consequences
- Moving a brewer to a stronger model is naming another level, not borrowing another role's alias; remapping a level moves every brewer on it.
- A second agent adds its own block to `models.jsonc` beside `claude`, with its models and its effort words, and the steps keep their levels and efforts (#691, #839).
- A test brewer or a Brewery's own brewer file that names `model` or `effort` is refused at load, and a recipe step that names neither is too; there is no fallback to a brewer's own level.
- A Brewery can no longer invent a model name of its own; a fourth level is a change of Foedrum.

## Alternatives considered
- **Free level names with the four as defaults**: keeps the role-name problem the change removes, since a Brewery could again name a level after a role.
- **The `--brewer` run's step on `standard`**: would move the scripted Gauger's model too, which the comparison holds to its own.
