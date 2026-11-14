# 0397. Brewers name a model level and an effort of Foedrum's own, which models.jsonc translates

Date: 2026-11-14 · Status: Accepted · Amends [0153](0153-foedrum-s-defaults-map-their-own-model-aliases.md) (`models.jsonc` holds one block per agent that translates levels and efforts, merged entry by entry), [0321](0321-mash-and-decoction-review-a-plan-through-the-plan-lenses-apart.md) (a step's `model` names a level, not an alias), [0352](0352-nip-s-correctness-acceptance-and-security-tasters-run-at-high-effort-without-the-rules-read.md) (a step's `effort` is one of Foedrum's four, and Nip's three Tasters run at `careful`), [0100](0100-nip-ships-with-a-default-cellarman-and-the-default-brewers-name-the-builder-alias.md) (the default brewers name `standard`, not `builder`), [0232](0232-foedrum-mash-routes-an-issue-to-the-innkeeper-whose-question-the-answer-chooses-the-recipe-by.md) (the Innkeeper is on `standard` at `quick`), [0234](0234-the-brewmaster-writes-a-plan-on-the-planner-alias-and-mash-runs-it.md) (the Brewmaster is on `strong`, not `planner`), [0323](0323-a-seeded-plan-measures-the-plan-lenses-apart-and-together-after-the-merge.md) (its steps on `planner` name `strong`), [0366](0366-deep-brew-builds-a-change-that-can-reach-a-lot-through-every-diff-lens-and-a-blocking-brett-step.md) (Deep-brew's `taste` step is on `strong`), [0394](0394-tasting-compare-real-runs-a-real-cellarman-on-a-model-and-effort-it-is-given.md) (`--effort` takes Foedrum's four, and the measured step is on `strong`, not `measured`), [0395](0395-the-maltster-maps-the-code-an-order-touches-before-the-gauger-on-the-explorer-alias.md) (the Maltster's map is on `light`, not `explorer`) and [0396](0396-tasting-compare-real-starts-a-cellarman-run-from-the-brewmaster-s-kept-sub-order.md) (the Brewmaster is on `strong`, and the planning stop reads `strong`'s family)

## Context
A brewer names a model alias and one of Claude Code's five effort words (`low`, `medium`, `high`, `xhigh`, `max`), and `models.jsonc` maps each alias to a model: `builder` to `sonnet`, `planner` to `opus`, `explorer` to `haiku` ([ADR 0395](0395-the-maltster-maps-the-code-an-order-touches-before-the-gauger-on-the-explorer-alias.md)).
The aliases name a role, not a level: `deep-brew`'s Taster and the coverage and security plan Tasters run on `planner` to get Opus, so moving one brewer to another model means moving it to an alias named after another role.
The effort words are one agent's: a second agent (#691, #839) has its own words or none.
Decided with the maintainer on 2026-11-14 (#1058).

## Decision
- **Three model levels replace the aliases**: `light` (was `explorer`), `standard` (was `builder`) and `strong` (was `planner`).
  The set is closed: a brewer, a step and a blind-tasting swap name one of the three, and the schema refuses any other name.
- **Four efforts of Foedrum's own** replace Claude Code's five words in the brewer schema and on a recipe step: `quick`, `steady`, `careful` and `thorough`.
- **`models.jsonc` holds one block per agent**, today one, `claude`, with `models` (a model id or family per level) and `efforts` (Claude Code's word per effort):

  ```jsonc
  { "claude": {
      "models": { "light": "haiku", "standard": "sonnet", "strong": "opus" },
      "efforts": { "quick": "low", "steady": "medium", "careful": "high", "thorough": "xhigh" } } }
  ```

  That is `defaults/models.jsonc`.
  `brewers`, the blind-tasting swap, stays at the top level and names a level, since a level belongs to no agent.
- **The merge stays entry by entry** (ADR 0153): the merged `claude.models` is the defaults' with the Brewery's over them, level by level, and `claude.efforts` the same, effort by effort; `brewers` comes from the Brewery's file only.
  A Brewery that wants `careful` to run at `xhigh` writes `{ "claude": { "efforts": { "careful": "xhigh" } } }` and nothing else.
- **The translation happens where the model's does**: `effortOf` beside `modelOf` (`src/brewers/attempt-plan.ts`), read by the attempt's plan, an interactive session and `foedrum resume`, so `claude --effort` gets Claude Code's word.
- **A level or an effort with no translation refuses the start**: `serveSetup` translates every brewer in use and every step's own level and effort, and names the brewer (`models.jsonc has no claude effort for the effort "careful" of the brewer "gauger"`), as a missing alias did.
- **No brewer changes model or how hard it thinks.** Every default brewer and step names the level and effort that translate to what it ran on before: `low` became `quick`, `medium` `steady`, `high` `careful`; nothing used `xhigh` or `max`.
  The default brewers keep their `version`: their prompts do not change.
- **`tasting-compare --real --brewer`'s `--effort` takes Foedrum's four efforts**, translated by the default efforts, so Claude Code's `max` cannot be measured by it without a Brewery of one's own that maps an effort to it.
  The measured step names `strong`, and the run's scratch Brewery maps only `claude.models.strong` to `--model`: no other step of `real-brew-cellarman` names `strong`, `light` and `standard` stay the defaults' (so a map step stays on Haiku), and no effort is mapped.
  The planning runs' scratch Brewery (`--sub-orders`) writes no `models.jsonc`, so the Brewmaster stays on the default `strong`.
  A run's setup ends in the Foedrum effort it was given, such as `855-cellarman-claude-opus-5-5-thorough`, not Claude Code's word.
  The `opus` setup swaps the Taster to `strong` with `brewers`, which is Opus by default, instead of adding an alias of its own.

## What an existing Brewery must do
Nothing: no Brewery runs Foedrum before its first publish, so the rename has no alias, migration or compatibility code.

## Consequences
- Moving a brewer to a stronger model is naming another level, not borrowing another role's alias; remapping a level moves every brewer on it.
- A second agent adds its own block to `models.jsonc` beside `claude`, with its models and its effort words, and the brewers keep their levels and efforts (#691, #839).
- A Brewery can no longer invent a model name of its own; a fourth level is a change of Foedrum.

## Alternatives considered
- **Free level names with the three as defaults**: keeps the role-name problem the change removes, since a Brewery could again name a level after a role.
- **The `--brewer` run's step on `standard`**: would move the scripted Gauger's model too, which the comparison holds to its own.
