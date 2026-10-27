# 0224. The default recipes taste apart or together as a seeded comparison measured

Date: 2026-10-27 · Status: Accepted · Amends [0220](0220-a-taster-s-step-can-run-several-lenses-together.md) (the measured choice, which it left to #567) and [0017](0017-test-first-recipes-and-tasting-lenses.md) (its rejection of one broad Taster, now measured)

## Context
A recipe can taste through its lenses apart, one Taster each side by side in a `parallel` group ([ADR 0168](0168-a-parallel-group-runs-its-lens-steps-side-by-side.md)), or together, one Taster whose step names `lenses` ([ADR 0220](0220-a-taster-s-step-can-run-several-lenses-together.md)).
[ADR 0017](0017-test-first-recipes-and-tasting-lenses.md) chose apart by reasoning alone ("less depth per concern"), and ADR 0220 left the measurement to #567.
Tasting is about a third of a batch's tokens (#260), and seven lenses apart read the order and the change seven times.
Nip tastes through correctness and acceptance apart ([ADR 0197](0197-acceptance-ships-as-a-default-diff-lens-and-nip-tastes-through-it-beside-correctness.md)); #391's `mash` and `decoction` follow this record.
The runs need the real `claude` with a login, which no test layer reaches ([ADR 0057](0057-real-claude-tests-are-opt-in-and-claude-proofs-leave-the-suite.md)), so they are by hand, as `/brew-review` on the planted samples is.

## Decision
- **The seeded change** is `test/fixtures/tasting-compare/`: a tiny repository as a base patch, with a CLAUDE.md whose one rule the change breaks, the change as a second patch, the order with a "What to build" checklist, and `key.json`, one planted defect per default diff lens (acceptance, correctness, cross-platform, design-conformance, necessity, security, test-design), each its lens's and not another's, at its file and line ranges. Its README lists the expected findings and what may appear and is not wrong. The patches are data: a unit test reads `key.json` against the lines the change adds, and none applies them.
- **How a run tastes.** `node scripts/tasting-compare.ts` brews one order through `foedrum brew`'s own `runBrew` in a scratch Brewery under `.foedrum/tmp/tasting-compare/<run>`, with the demo's fake code host and git configuration ([ADR 0097](0097-npm-run-demo-is-a-script-on-serve-s-seams-with-the-tests-fakes.md)): a scripted Cellarman (no model) commits the change, and the Tasters' steps run on `claudeBrewerRunner`, so each Taster gets what a batch gives it: the `change` input, its lens input, its out doc schema, and no house yeast, the same for every setup. Every Taster is the default `taster` brewer with its model and effort. Its recipe is one of three setups: `apart-7` (a `parallel` group of the seven one-lens steps), `together-7` (one step with the seven `lenses`) and `together-nip` (correctness and acceptance in one step). Nip's two apart are read from `apart-7`'s two steps, never run again: the same attempts a Nip batch would run.
- **What counts as found**: a finding whose file is the defect's and whose line is in one of its ranges, whatever lens it names; a defect found twice counts once. The table also says how many found defects a finding of the defect's own lens named (`lensOfFinding`). Every other finding is listed per run for a person to judge, and not scored.
- **A failed run**, one whose batch is not on tap or one of whose Taster attempts failed (an invalid out doc, a stall), is shown as failed and run again, at most once; the table counts it.
- **What is measured per setup, over 3 runs**: the planted defects found out of seven (Nip's out of two) per run and per defect; the other findings; the tokens (input, output, cache read, cache write, from `step.finished`'s `usage`, summed per run, and their sum); the turns and the attempts' `durationMs` from the receipt ([ADR 0172](0172-an-attempt-s-receipt-from-its-stream.md)); and the run's wall time, with the lenses apart side by side. Never a cost ([ADR 0181](0181-receipts-show-no-cost.md)).
- **The rule that picks the default**, written before the runs: a recipe tastes together when its together setup finds on average at least as many planted defects as apart, less half a defect, with at least 30 % fewer tokens (the four kinds summed); otherwise it stays apart. Nip's choice follows its two lenses' numbers. The seven lenses' numbers are guidance for #391's `mash` and `decoction` and for `/brew-review`, which this record does not change.
- **The numbers**, from the runs of 2026-10-27 (3 runs per setup, the default `taster` on the alias `builder`, `sonnet`, at effort medium; no run failed). They are means per run; the tokens are summed over a run's Taster attempts.

  | Setup | Found | Per run | Own lens | Other findings | Output | Cache read | Cache write | Tokens | Turns | Attempts | Wall |
  |---|---|---|---|---|---|---|---|---|---|---|---|
  | apart-7 | 7 / 7 | 7, 7, 7 | 6.3 | 3 | 15,068 | 163,198 | 62,598 | 240,903 | 21.7 | 175 s | 84 s |
  | together-7 | 6.3 / 7 | 6, 6, 7 | 6.3 | 1.3 | 3,277 | 51,136 | 19,210 | 73,630 | 4.3 | 30 s | 74 s |
  | apart-nip | 2 / 2 | 2, 2, 2 | 2 | 4.3 | 5,306 | 31,829 | 19,116 | 56,259 | 4.7 | 55 s | 31 s |
  | together-nip | 2 / 2 | 2, 2, 2 | 2 | 4.3 | 3,096 | 29,683 | 11,397 | 44,183 | 3.7 | 27 s | 65 s |

  Input tokens outside the cache were at most 39 per run. Every planted defect was found in every run of every setup, except design-conformance's `node:fs` outside the store, which together-7 found in 1 run of 3. Apart, the necessity lens's own Taster reported its defect in 1 run of 3, and other lenses' findings on its lines caught it in the other two; together, a finding named `diff/necessity` caught it in all three. apart-nip's wall time is the longer of its two attempts, since they run side by side. Most other findings in every setup are one defect that was not planted: `--days` with no number gives `NaN`, and `remind` then lists nothing. The full table, with every other finding, is in the pull request that closes #567.

- **The choice.** Nip stays apart: together found the same 2 of 2 with 21.5 % fewer tokens (44,183 against 56,259), short of the rule's 30 %, so `defaults/recipes/nip.jsonc` keeps its group of two lens steps. Seven lenses stay apart as well: together saved 69 % of the tokens (73,630 against 240,903) but found 6.3 defects to apart's 7, more than half a defect fewer. For #391's `mash` and `decoction`, and for `/brew-review`, many lenses together cost about a third of the tokens, at the risk of a lens's defect left unreported when the one Taster's attention goes to the others' (here design-conformance's).

## Consequences
- A recipe author can read what together costs in found defects and saves in tokens on one seeded change, instead of a reason.
- The comparison runs again by hand (`node scripts/tasting-compare.ts`) when a lens, the Taster's prompt or its model changes; its core is unit-tested, its runs are not.
- One seeded change of seven defects is a small sample: three runs show the spread of one model on one change, not every change's.
- A lens that misses its own planted defect apart is a finding about that lens, filed as an issue of its own; this record changes no lens file and no `taster.md`.

## Alternatives considered
- **`claude -p` with a hand-built prompt per setup.** It would measure a prompt Foedrum never sends: no lens input as the plan builds it, no out doc schema, no fixed text of a `lenses` step.
- **A real Brewery on GitHub.** A login and a repository the comparison does not need; the fake code host gives the engine all it reads.
- **Nip's two apart as a fourth setup.** The same steps as two of `apart-7`'s, on the same change: three more runs that measure nothing new.
- **A finding counted only when it names the defect's lens.** A defect another lens reports is still caught; the table shows the lens apart.
- **Scoring the other findings.** Whether a finding outside the key is right needs a person; the table lists them instead.
- **Cost in dollars.** ADR 0181 records no cost, and the list price changes; tokens are what a batch spends.
- **A model comparison** (a Taster on another alias per setup). That is the Flight's question ([docs/design/evaluation.md](../design/evaluation.md)), not this one.
