# 0344. tasting-compare --real measures a stronger model and more effort apart

Date: 2026-11-07 · Status: Accepted · Amends [0332](0332-tasting-compare-real-re-tastes-brewed-heads-and-writes-blinded-lists.md) (two more setups, where a record's model comes from, a run on another model stops the comparison, and `--setups`) and [0337](0337-a-taster-s-first-call-on-a-diff-reads-the-instruction-file-and-a-long-risk-line-is-cut.md) (which setups brew `real-nip`)

## Context
#879's final comparison ran `nip`'s three Tasters on three real changes, all on Sonnet at medium effort, and `today` and `reads` wrote no finding in 54 Tasters.
A review with stronger models had found the same defects, but that review also differed in context and rules, so nothing says whether the model or the effort makes the difference.
#879's rule points at the model next, and #915 needs the answer to choose which Tasters get a stronger model.

## Decision
- **Two more setups on all three orders, each changing one thing against `reads`:** `opus`, named like `855-opus`, and `high`, named like `855-high`. Both have the default Taster's instructions, `nip`'s three lenses, `real-nip` as their recipe, the same order and base, and no comment.
- **`opus` is set by the scratch Brewery's `models.jsonc`:** `{ "models": { "opus": "opus" }, "brewers": { "taster": "opus" } }`. It merges over the default aliases, as a Brewery's file does ([ADR 0153](0153-foedrum-s-defaults-map-their-own-model-aliases.md)), and `brewers` moves the Taster and no other brewer. No Taster text changes, and neither does the recipe, though a recipe step's `model` could have set it: that would make the recipe differ too.
- **`high` is set by the scratch Brewery's `brewers/taster.md`:** the default's text with `"effort": "medium"` changed to `"effort": "high"`, read when the run starts, since effort has no other setting: a recipe step has none, and `models.jsonc` has none. A default that does not hold that text exactly once refuses before any session, as a later edit could otherwise compare nothing. The Taster's `version` does not change: the setup changes the scratch Brewery alone.
- **A test holds each setup to its one change at the command line:** `the opus setup differs from reads by the Taster's model alone` and `the high setup differs from reads by the Taster's effort alone` load the scratch Brewery through `serveSetup` and build `claudeArgs` of a Taster's step. Its line equals `reads`'s but for the value of `--model`, or of `--effort`, and for `opus` a Cellarman's line stays the same as `reads`'s.
- **A record's model is what the transcript's assistant lines name**, not ADR 0332's receipt: it is one source per session, and it is what the check below reads and `codes.md` shows. `<synthetic>`, which claude writes on a line it made up for a failed call, is no model and is left out.
- **A run on a model its setup did not ask for stops the comparison at once**, with no record of that run, and not only for these setups: `opus` asks for an id holding `opus`, and every other setup for one holding `sonnet`, since an alias asks for a family. A session on two models stops it too. So does a Taster that finished with a transcript that names no model, as a transcript that cannot say does in ADR 0332. An attempt that failed by itself with no model named stops nothing: it is a failed run, run again once.
- **This is a stop, and a read outside its worktree is not.** ADR 0332 fails only the run for a read outside, since the Taster did it, and running it again is a measurement. A wrong model is the harness's or the login's, every later run would have it too, and each would spend sessions on nothing, so it goes with ADR 0332's transcript that cannot say.
- **Effort is not in a transcript, so what is known is what was passed.** The tests above pin the line, and every run prints each Taster's `--model` and `--effort`, read from the attempt's plan, the call the runner's `claudeArgs` is built from. Nothing checks it after a run: whoever runs the comparison keeps that output.
- **`--setups <names>`, on `--real` only, runs only those**, such as `--setups opus,high`, by the part of a setup's name after its order, in the order a whole run walks them. A name no setup has refuses before anything runs, and names those it knows. Without `--real` it refuses too. `results.jsonl` still lets a stopped run go on, and the lists, `codes.md` and the table read every record in the folder, chosen or not.
- **The dry run shows them working**, with no token spent: `--real --dry-run --setups opus,high` plays the Tasters, and each scripted transcript names the model its attempt was planned with, so a scratch Brewery that asked for the wrong model stops the dry run too.
- **The key and the bar stay #879's.** The program scores nothing.
- **A Brewery need do nothing:** nothing in one changes, and this runs only by hand in scratch folders.

## Consequences
- No number exists when this record is accepted: the maintainer runs it after the merge, 3 runs per setup, 54 Taster sessions, scored by someone who has not seen the setups. It is to decide whether `nip`'s three Tasters keep their first read of the instruction file, and to feed #915.
- The check on a real Opus transcript is not proved here, and no real `claude` ran for this record. Only ADR 0332's `claude-sonnet-5-5` was read from a real transcript. A first `--runs 1` shows it, and a wrong reading stops at the first Taster.
- A transcript does not show whether `--effort` changed what the model did, only that the option was given.
- These runs add to a folder that holds #879's records, and their codes go into the same lists; a fresh folder holds only what `--setups` chose. A list does not name a model or an effort, so it stays as blind as ADR 0332 says.

## Alternatives considered
- **A recipe of its own per setup, with a step's `model`.** Each recipe would then differ, and effort still could not be set there.
- **Adding `effort` to a recipe step.** It would change `src/` and the recipe's schema to serve a script.
- **The receipt's model for the check.** It is usable, but the dry run's scripted receipt names none, so the check would run only with tokens spent.
- **Failing only the run on a wrong model.** A retry would run on the same model, and so would the rest.
