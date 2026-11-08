# 0352. Nip's correctness, acceptance and security Tasters run at high effort, without the rules read

Date: 2026-11-08 · Status: Accepted · Amends [0343](0343-nip-tastes-through-design-conformance-as-a-fourth-advisory-lens.md) (Nip's Tasters run at their brewer's effort), [0347](0347-tasting-compare-real-measures-tasters-without-the-rules-read-and-three-lenses-together.md) (the setups start from the default Taster, and the cut is of the default), [0344](0344-tasting-compare-real-measures-a-stronger-model-and-more-effort-apart.md) (`reads`, `opus` and `high` taste the default Taster), [0337](0337-a-taster-s-first-call-on-a-diff-reads-the-instruction-file-and-a-long-risk-line-is-cut.md) and [0331](0331-a-taster-on-a-diff-reads-the-repository-s-rules-as-its-standard.md) (every diff Taster reads the repository's rules first), [0321](0321-mash-and-decoction-review-a-plan-through-the-plan-lenses-apart.md) (a step overrides its brewer's model alone)

## Context
#879 measured `nip`'s Tasters on three brewed heads with a key fixed before any run.
Today's setup (Sonnet, medium effort, reading the instruction file first) caught none of the key's five items, and the main code defect (M1) in 0 of 5 runs.
Sonnet at high effort without the read (`high-bare`, [ADR 0347](0347-tasting-compare-real-measures-tasters-without-the-rules-read-and-three-lenses-together.md)) caught M1 in 3 of 3, for 589k tokens per batch against 507k and 554k.
With the read, the same setup cost 1,095k and caught about the same.
#936 tasted the same three lenses in one Taster on Sonnet at high effort: M1 in 1 of 3, so on Sonnet they stay apart.
#879 did not test design conformance without the rules: its lens judges the change by them.
A recipe step can override its brewer's model ([ADR 0321](0321-mash-and-decoction-review-a-plan-through-the-plan-lenses-apart.md)) but not its effort, and every Taster runs on the one `taster` brewer.

## Decision
- **A brewer step may name an `effort`** (`low`, `medium`, `high`, `xhigh`, `max`, the brewer's own enum), which overrides its brewer's on that step alone, as `model` does: the recipe loader applies both to the step's brewer, so the attempt's `claude` line, an interactive session and `foedrum resume` all read it.
  A step without one runs at its brewer's effort.
- **A blind-tasting swap keeps a step's effort.** `models.jsonc`'s `brewers` swaps a brewer's model alias and says nothing of effort, so the swapped model runs at the step's effort. A test holds it.
- **`nip`'s correctness, acceptance and security steps name `"effort": "high"`.** Design conformance, the plan Tasters of `mash` and `decoction`, and every other step keep the Taster's `medium`. Each stays a Taster of its own, side by side.
- **The default Taster no longer tells a diff Taster to read the repository's rules.** [`taster.md`](../../defaults/brewers/taster.md) loses the texts ADR 0347's cut leaves out, with two plan sentences kept: "Read the change first" keeps `on a plan, read the repository's instructions and design documents when the lens asks you to check against them`, the section keeps `A step that reviews a plan skips this section.`, and the body's line becomes `On a plan, in your out doc's body, say what you read and what you checked through the lens.` A plan Taster reads and reports as before.
  The section's "What they are" and "When the change edits them" bullets stay, for a Taster that opens the rules because its lens asks or by itself. Its `version` goes from 10 to 11.
- **The design-conformance lens asks for the rules itself**, in a section `## Read the rules first` before what it looks for: its Taster's first tool call reads the instruction file, then what that file or the changed code names for the files the change touches, and its body starts with the `Rules read:` line. Its words are the ones the Taster's prompt had. A lens file has no version, so none is raised.
- **A lens that judges by the repository's rules says so itself.** The default correctness, cross-platform and test-design lenses name the repository's instructions only as a condition ("if the repository's instructions state …"), as `high-bare` was measured. A Brewery's own diff lens that needs the rules read must ask for them, as design conformance now does.
- **`tasting-compare --real` keeps its setups as they were measured.** Every setup but `today` starts from a pinned copy of the Taster that reads, `test/fixtures/tasting-compare/real/taster-reads.md` (the default before this record), instead of the default: `reads`, `lens`, `opus` and `867-comments` write it as the scratch Brewery's `brewers/taster.md`, and `high` and the `-bare` and `-together` setups cut it as before. The cut still stops the comparison on a text that does not hold each of its five texts once, and the default now holds none of them, which a test holds. `--real --dry-run --setups high-bare` shows the Tasters at `high` effort with no read line.

## What an existing Brewery must do
- **A Brewery with its own `nip.jsonc`** keeps its Tasters' effort until it adds `"effort": "high"` to its correctness, acceptance and security steps, as the default's do.
- **A Brewery with its own `brewers/taster.md`** keeps its read of the rules on every diff step. To follow the default, it takes out the five texts ADR 0347 lists, keeping the plan sentences above.
- **A Brewery with its own `lenses/diff/design-conformance.md`**, or another lens that judges by the repository's rules, adds the default lens's `## Read the rules first` section once its Taster no longer reads them. Without it, that Taster judges by rules it opens only on its own.
- A Brewery with none of these files does nothing: Foedrum's defaults change under it.

## Consequences
- Each of the three Tasters reads no rules unless its lens or the change leads it there, so a finding that rests on a rule of the repository now comes from design conformance. In #879, `high`, whose Tasters read the rules, caught none of the key's three such items (D1, D2 and M3) either.
- High effort costs more per session than medium. #879's measure: 589k tokens per batch for `high-bare`, against 507k and 554k for today's setup, and 1,095k for high effort with the read.
- The design-conformance lens is also a checklist for `/brew-review`'s Tasters and `/brew-audit`'s auditors. Their prompts already have them read the rules first, so the lens's ask repeats it.
- The setups of `tasting-compare --real` no longer follow the default Taster. A later edit to `taster.md` needs a new setup to be measured, as `today` was pinned before.

## Alternatives considered
- **A second brewer, `taster-high`, at high effort and without the read.** It would copy `taster.md`, and a Brewery's own `taster.md` would no longer cover `nip`'s three steps.
- **`effort` in `models.jsonc`, beside a brewer's alias.** It would move every step of that brewer, the plan Tasters' too.
- **Keep the read in the Taster and drop it per lens.** A lens cannot take a line out of the brewer's prompt. Asking from the lens that needs the rules keeps the brewer's text one for all.
- **The three lenses together in one Taster.** #936 measured it on Sonnet at high effort: M1 in 1 of 3.
- **Keep the `-bare` setups on the default.** They would cut nothing and stop, and `reads`, `opus` and `high` would no longer read the rules they were measured with.
