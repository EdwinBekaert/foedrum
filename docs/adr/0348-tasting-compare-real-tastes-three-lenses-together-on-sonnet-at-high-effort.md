# 0348. tasting-compare --real tastes three lenses together on Sonnet at high effort

Date: 2026-11-08 · Status: Accepted · Amends [0347](0347-tasting-compare-real-measures-tasters-without-the-rules-read-and-three-lenses-together.md) (a fourth setup of its kind)

## Context
#879's comparison under [ADR 0347](0347-tasting-compare-real-measures-tasters-without-the-rules-read-and-three-lenses-together.md) measured three lenses in one Taster only on Opus (`opus-together`).
It caught what three Opus Tasters apart caught, with fewer tokens per batch.
#935 moves `nip`'s correctness, acceptance and security Tasters to Sonnet at high effort without the read of the instruction file, which is `high-bare`'s Taster.
Whether those three lenses can run together on that Taster is untested on brewed heads: [ADR 0224](0224-the-default-recipes-taste-apart-or-together-as-a-seeded-comparison-measured.md) measured together against apart only on a seeded change, at medium effort.
The setups of `tasting-compare --real` are a fixed list in `scripts/tasting-compare/real.ts`, so a new one needs code.

## Decision
- **A setup `high-together` on all three orders**, named like `855-high-together`, after `opus-together` in each order.
- **`high-together` is `high-bare`'s Taster with `opus-together`'s recipe.** The scratch Brewery's `brewers/taster.md` is `high-bare`'s, the default's text at `high` effort with ADR 0347's cut. The recipe is `real-nip-together`, whose one step `together` tastes `diff/correctness`, `diff/acceptance` and `diff/security` ([ADR 0220](0220-a-taster-s-step-can-run-several-lenses-together.md)). It writes no `models.jsonc`, so the Taster stays on the default's `taster` alias, Sonnet. The test `the high-together setup is high-bare's Taster with the three lenses in one step on Sonnet` holds the recipe's step, the Brewery's files, and the `claude` line, which equals `high-bare`'s: `--model sonnet --effort high`.
- **A run on another model stops it**, as before ([ADR 0344](0344-tasting-compare-real-measures-a-stronger-model-and-more-effort-apart.md)): `high-together` asks for an id holding `sonnet`.
- **The lists show it as ADR 0347 shows `opus-together`**: one Taster per lens, under the headings an apart Taster has, in the recipe's order. With the run's heading taken out, a `high-together` run's list reads the same as a `high-bare` run's with the same findings and risks, and a test holds it to that. `codes.md` keeps one row per run, `together`, with the transcript's model id, `claude-sonnet-*`.
- **`--setups high-together` brews only it**, and `--comparison <name>` keeps its records and lists in a folder of their own, as ADR 0347 has it.
- **The key and the bar stay #879's.** The program scores nothing.
- **A Brewery need do nothing:** nothing in one changes, no default brewer's `version` changes, and this runs only by hand in scratch folders.

## Consequences
- No number exists when this record is accepted: the maintainer runs `--real --setups high-together --runs 3` after the merge, in a comparison of its own, 9 Taster sessions, scored blind as #879's were. The result goes on #936 and #935.
- What ADR 0347 says of `opus-together` holds for `high-together` too: its lists are not wholly blind, since a together Taster leaves fewer risk lines and one body where three apart leave three, its tokens are one session's, and a risk line that starts with no lens of its step is shown under its first lens.
- A comparison of `high-together` against `high-bare` reads `high-bare`'s runs from #879's comparison, in another folder with another seed: the scorer scores each comparison's lists apart.

## Alternatives considered
- **A setup option for the model and the effort of a together step.** The fixed list keeps each setup's difference in one place a test pins; a fourth together setup is one name.
- **Change `opus-together` to Sonnet.** The records of its earlier comparison would then name a setup that tasted another way.
