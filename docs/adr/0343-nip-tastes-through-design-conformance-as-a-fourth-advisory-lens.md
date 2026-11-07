# 0343. Nip tastes through design conformance as a fourth, advisory lens

Date: 2026-11-07 · Status: Accepted · Amends [0306](0306-nip-tastes-through-the-security-lens-beside-correctness-and-acceptance.md) (Nip's three Tasters, and that the demo keeps its three), [0185](0185-npm-run-demo-tastes-through-a-parallel-group-of-three-lenses.md) (the demo's group of three), [0264](0264-nip-s-correctness-taster-blocks-and-sends-its-findings-back-to-cellarman.md) (the demo's three lenses, and the group it routes), [0224](0224-the-default-recipes-taste-apart-or-together-as-a-seeded-comparison-measured.md) (its Nip setups are no longer Nip's lenses), [0332](0332-tasting-compare-real-re-tastes-brewed-heads-and-writes-blinded-lists.md) (the test that holds `real-nip` to `nip`) and [0337](0337-a-taster-s-first-call-on-a-diff-reads-the-instruction-file-and-a-long-risk-line-is-cut.md) (`nip.jsonc` unchanged, and which recipe a test holds to it)

## Context
#374's self-brew orders showed `nip`'s Tasters approving heads where a stale design page or a missing decision record went through.
#879 measured it with `tasting-compare --real` ([ADR 0332](0332-tasting-compare-real-re-tastes-brewed-heads-and-writes-blinded-lists.md), [ADR 0337](0337-a-taster-s-first-call-on-a-diff-reads-the-instruction-file-and-a-long-risk-line-is-cut.md)): 30 runs, 99 Taster sessions, all on `claude-sonnet-5-5`, no harness stops, marked by a scorer who had not seen the setups.

D1 is the stale page on #855, D2 the one on #864, and M3 the missing record on #867; M1 and M2 are #867's other two defects.

| Setup | D1 | D2 | M3 | M1 | M2 | Findings outside the key | Tokens per batch |
|---|---|---|---|---|---|---|---|
| `today` | 0/3 | 0/3 | 0/3 | 0/3 | 0/3 | none | 119k–399k |
| `reads` | 0/3 | 0/3 | 0/3 | 0/3 | 0/3 | none | 328k–825k |
| `lens` | 3/3 | 3/3 | 2/3 | 0/3 | 1/3 | 3 true, 2 false | 649k–1,124k |

## Decision
- **`diff/design-conformance` joins `nip`'s `taste` group as its fourth step**, last: `{ "id": "design-conformance", "brewer": "taster", "lens": "diff/design-conformance" }`. The maintainer decided it from the table on #879, and it was the only setup that caught any of those defects.
- **It advises**, as acceptance and security do ([ADR 0306](0306-nip-tastes-through-the-security-lens-beside-correctness-and-acceptance.md)). Its findings are listed where every Taster's are, its `changes` opens the pull request as a draft, and it sends nothing back. Correctness alone blocks. `mash` and `decoction` do not change.
- **The comparison keeps what it measured.** `real-nip` stays the three Tasters and `real-nip-lens` the four; the test that held `real-nip` to `defaults/recipes/nip.jsonc` now holds `real-nip-lens` to it, and `real-nip` is pinned by name. Their recipes' descriptions name their lenses, since "as nip tastes it" is no longer true of `real-nip`.
- **ADR 0224's seeded comparison keeps Nip's three lenses as measured.** `scripts/tasting-compare/core.ts`'s `NIP`, `together-nip` and `apart-nip` stay as they are, and the table's line says it compares those three and not `nip` as it is now. `--plan` compares `mash`'s lenses, which did not change, and its line already names `mash`. ADR 0224's choice, Nip apart, stands on what it measured, and `together-7`, which found design conformance's defect in 1 run of 3, gives no reason to fold this lens in.
- **`npm run demo` follows.** Its own group becomes correctness, security, test design and design conformance, the last with one scripted minor finding, so a newcomer reads that Taster where it will show on a real batch: on `foedrum status`, on the status comment's path and under its Findings, and in `foedrum lenses`. The demo keeps test design, and leaves out acceptance as before, because its walkthrough says a lens outside the recipe has no rounds. `npm run demo -- ladder` tastes no diff, so it does not change.
- No default brewer's `version` changes, and the lens's text does not. Whether the other Tasters keep their first call to the instruction file is a separate decision.

## Consequences
- **Cost, measured.** About 300k tokens more per tasting round of a batch, the distance between `reads` and `lens` in the table, on three heads of one repository. It is a measure of those heads and of a repository with many rules to read, not of every change. The time is that of the slowest of the four.
- **It missed #879's bar.** The bar asked for M1, M2 and M3, and `lens` has only M3 of them, at 2 of 3. Two of #867's three defects need a Taster the lens is not. M3 is also a judgement call: both findings name the new failure with no decision record and no design line, and neither says that nothing decides how such a batch ends; read strictly, it is 0 of 3. The maintainer decided for the lens all the same, and by #879's rule a miss on M1 or M2 points at the model next.
- **Two of the five findings outside the key were false.** An advisory Taster costs a person a reading of them, not a round.
- **The first batch to land on a stale page reads one more finding**, and a Taster's `changes` opens its pull request as a draft.
- **The Brewery's `concurrency` does not hold the fourth Taster.** It and a recipe's `concurrency` count batches, so a Brewery with a `concurrency` of 1 runs one batch and all four Tasters of it side by side, each a session in a worktree of its own, and nothing limits attempts. The driver knows no such limit, and the batch takes one place. `test/unit/default-nip.test.ts` shows the four starting before any ends, and that one batch fills a `concurrency` of 1 and leaves one place of 2. What a fourth session spends counts toward the subscription's usage window ([ADR 0206](0206-a-run-out-usage-window-holds-every-brewer-attempt-until-it-reopens.md)).
- **What cuts sooner.** The status comment holds each Taster's own limits, ten findings and five risks, so the fourth takes nothing from the others', and a rendered one stays far under its 60,000 characters. The pull request's reports share one 25,000 characters, in the order the steps were first scheduled, so a long batch's cut (`(cut short)`) comes sooner, and it falls first on design conformance, the last Taster. Its findings stay on the status comment. No number here says how often it happens.
- **The lens names no file.** It asks for what the repository's decisions and documents say, and the Taster's first bullet and its section on the repository's rules say what to read. The comparison ran with that first bullet, so whether the lens finds as much without it is not measured.
- The changed default recipe is tried by the maintainer on real issues after the merge.

## Migration
**A Brewery with no `recipes/nip.jsonc` of its own** gets the fourth Taster on upgrade, and need change nothing.

**A Brewery with its own `recipes/nip.jsonc`** keeps its Tasters until it adds the step. `foedrum doctor` already says that the file replaces the default, not which step it lacks. In its `taste` group, after its last child, with a comma after that child:

```jsonc
        { "id": "design-conformance", "brewer": "taster", "lens": "diff/design-conformance" }
```

The lens loads from the defaults, and a Brewery's own `lenses/diff/design-conformance.md` replaces it.

**A running batch does not keep the recipe it started with.** A batch records its recipe's name, and each driver reads that name in the recipes it loaded when it opened. So after an upgrade and a restart:

- a batch before `taste` tastes through the four;
- a batch inside `taste` goes Stuck on a divergence once the Tasters it scheduled have ended ([ADR 0168](0168-a-parallel-group-runs-its-lens-steps-side-by-side.md)). `foedrum retry` then runs only the new Taster, and the group reads its verdict: on to the pull request, or back to Cellarman when correctness asked for changes. `foedrum skip` goes on to the pull request without it, past those changes too, so `retry` is the one to use then;
- a batch past `taste` is not touched, unless a route sends it back, and then the group runs the four.

Nothing here pins a recipe to its batch, which is a decision of its own.

## Alternatives considered
- **Block on its findings.** A stale page is rarely what a Cellarman round should be spent on, two of its findings in the comparison were false, and one blocking Taster already shares the batch's rounds. A Brewery that wants it to block sets `"blocking": true` and an `onBlocked` findings route on the step in its own `nip.jsonc`.
- **Keep the three and leave the lens to `/brew-review`.** A brewed change reaches a person with what its Tasters found, and `today` and `reads` found none of these in 54 Tasters.
- **Fold the questions into the correctness lens.** The lenses would overlap again ([ADR 0022](0022-five-default-lenses.md)), and the comparison measured this lens as a Taster of its own.
- **Leave the demo at three, as ADR 0306 did.** The issue asks that the demo show what a person sees, and a newcomer would never see the Taster that every `nip` batch now runs.
- **Move `NIP` and `real-nip` to the four.** It would change what the numbers above and ADR 0224's mean.
