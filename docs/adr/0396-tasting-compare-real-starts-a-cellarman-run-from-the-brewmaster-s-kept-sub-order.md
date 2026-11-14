# 0396. tasting-compare --real starts a Cellarman run from the Brewmaster's kept sub-order

Date: 2026-11-14 · Status: Accepted · Amends [0394](0394-tasting-compare-real-runs-a-real-cellarman-on-a-model-and-effort-it-is-given.md) (a `--brewer` run can start from the Brewmaster's sub-order, not only the order's issue text, and `codes.md` says which), [0332](0332-tasting-compare-real-re-tastes-brewed-heads-and-writes-blinded-lists.md) (a mode of `--real` that plans the orders and keeps their sub-orders), [0344](0344-tasting-compare-real-measures-a-stronger-model-and-more-effort-apart.md) (its model stop holds the Brewmaster too) and [0366](0366-deep-brew-builds-a-change-that-can-reach-a-lot-through-every-diff-lens-and-a-blocking-brett-step.md) (`--orders` also chooses the orders `--sub-orders` plans)

## Context
Since ADR 0394 a real Cellarman builds each of #879's three orders from the order's own issue text and the head's failing tests.
In a mash, a sub-order's text is the Brewmaster's, written on Opus, not a person's.
The question, answered after the merge by a run by hand: does an Opus plan let Cellarman on Sonnet write the code as well as Cellarman on Opus?
That needs four setups: from the order's own text on Sonnet (A) and on Opus (B), and from the Brewmaster's sub-order on Sonnet (C) and on Opus (D).

## Decision
- **`--real --sub-orders` plans each order once**, the three of ADR 0332 or those `--orders` names, through the real Brewmaster as it ships: the `planner` alias and its own effort, or scripted with `--dry-run`.
  Its recipe, `real-plan-brewmaster`, is a mash of the `plan` step alone, with no Taster, so the batch waits Stuck for the plan's review once the plan is written ([ADR 0275](0275-a-finished-plan-waits-stuck-for-its-review-and-every-comment-links-the-doc-it-sums-up.md)) and the run ends there.
  The target is the order's base, the issue the order's own text, as in ADR 0394.
  It is refused beside `--brewer` or `--setups`, and without `--real`.
- **A plan of one sub-order is kept as that sub-order's text**, in `real/sub-orders/<order>.md`, or `real/comparisons/<name>/sub-orders/<order>.md` with `--comparison <name>`: the sub-order's title on the first line, as an order's own file has it, then its plan entry as `planEntryText` renders it for a sub-order's brewers ([ADR 0290](0290-a-sub-order-s-brewers-read-its-plan-entry-from-the-parent-s-recorded-plan.md)).
  Beside it, `<order>-plan.json` keeps the Brewmaster's whole out doc.
- **An order the Brewmaster splits has no setups C and D.**
  Each head built its whole order, and the scripted Gauger commits all of its tests: one sub-order of several would build part of the order against tests for all of it, and joining the entries would undo the split the measure is about.
  A plan of more than one sub-order, or an out doc with no plan, such as a question, keeps only `<order>-plan.json`, and the printed table says why.
  This is a result to report, not a failed run: the order is not planned again on its own; a person deletes its record to plan it again.
  A run whose Brewmaster ended with no out doc measured nothing, and is planned once more, as ADR 0332's runs are.
- **A Brewmaster on a model outside the `planner` alias's family, `opus`, stops the comparison**, and so does one whose transcript cannot say, as [ADR 0344](0344-tasting-compare-real-measures-a-stronger-model-and-more-effort-apart.md) has it for the Tasters.
- **`--order-text plan` on a `--brewer` run builds from the kept text** instead of the order's own; `issue`, the default, is ADR 0394's run, its setups and files unchanged.
  A `plan` run's setup ends in `-plan`, such as `855-cellarman-claude-sonnet-5-5-high-plan`, so setups A to D share one comparison folder and their lists are blinded together.
  Every run of C and D reads the same kept file.
  A kept text missing for any order of the run refuses the whole run before anything brews, naming each missing file; it never falls back to the order's own text.
- **The records say which text a run started from**: its settings carry `orderText: "plan"`, and `codes.md` gains a `Text` column, `issue` or `plan`.
  The lists show only each run's code diff under its code, so a scorer reads no text of a run's start.
- **A Brewery need do nothing:** nothing in one changes, and this runs only by hand in scratch folders.

## Consequences
- No number exists when this record is accepted: the maintainer plans the three orders, then runs A to D in one comparison and scores the lists blind against #879's key.
- A real sub-order's Cellarman reads the sub-issue's body as its order and the plan entry as `planEntry`; here it reads the plan entry as its order, and no `planEntry`.
  The entry holds every line of the sub-issue's body but its first, which names the parent order and its batch.
- Windows' path limit is a known limit of the measure, not something to fix here.
  A dry run under `--comparison check-1052`, from a worktree under `.claude/worktrees/`, failed each green attempt with `the base could not be merged: git update-ref failed: fatal: '$GIT_DIR' too big` before any check ran; its attempt's worktree was `.foedrum/tmp/tasting-compare/real/comparisons/check-1052/brewers/dry-run/855-cellarman-claude-sonnet-5-5-high-plan-1/work/demo.web/attempts/1-1/green/1` inside that worktree, 205 characters from the drive.
  Foedrum's git already runs with `core.longpaths=true` (`gitEnv` in `src/workspace/git.ts`, [ADR 0024](0024-state-branch-layout-outbox-and-divergence.md)), and the error came anyway.
  The same run without `--comparison`, 182 characters, went on tap; a run from the main checkout with a short `--comparison` name stays under that.

## Alternatives considered
- **Join every sub-order's entry into one text**: it would build the order whole from a plan that split it, which measures neither the plan nor the order.
- **Pick the sub-order whose touches overlap the head's code the most**: it would build part of the order against tests of the whole.
- **Plan again until the Brewmaster writes one sub-order**: it would choose the plans that fit the measure, and the measure would no longer say what an Opus plan gives.
